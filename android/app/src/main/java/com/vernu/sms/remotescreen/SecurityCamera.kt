package com.vernu.sms.remotescreen

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.vernu.sms.R
import com.vernu.sms.dtos.RemoteScreenFrameData
import com.vernu.sms.dtos.RemoteScreenFrameRequest
import com.vernu.sms.dtos.RemoteScreenStatusRequest
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Security camera: lets the dashboard watch a phone's camera live (e.g. a
 * phone mounted in a server room). Armed from the app's Settings; a quiet,
 * minimised foreground service keeps camera access available, and the camera
 * itself only opens while a viewer is watching. Android still shows its own
 * camera-in-use indicator while streaming — that is not hidden.
 */
object SecurityCamera {
    private const val TAG = "SecurityCamera"
    private const val PREFS = "security_camera"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_BACK = "back_camera"
    private const val KEY_ROTATION = "extra_rotation"
    private val SESSION_ID = Regex("^[a-f0-9]{32}$")

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, false)

    fun hasPermission(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    fun isBackCamera(context: Context) = prefs(context).getBoolean(KEY_BACK, true)

    fun toggleCamera(context: Context) =
        prefs(context).edit().putBoolean(KEY_BACK, !isBackCamera(context)).apply()

    fun extraRotation(context: Context) = prefs(context).getInt(KEY_ROTATION, 0)

    fun rotate(context: Context) =
        prefs(context).edit().putInt(KEY_ROTATION, (extraRotation(context) + 90) % 360).apply()

    /** From the Settings switch (app in the foreground). */
    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
        if (enabled) arm(context) else context.stopService(Intent(context, SecurityCameraService::class.java))
    }

    /**
     * Starts the camera service. Android only grants camera access to a
     * foreground service started while the app is visible, so this is only
     * called from the app's own screens (Settings switch, app opened).
     */
    fun arm(context: Context) {
        if (!isEnabled(context) || !hasPermission(context)) return
        if (SecurityCameraService.instance != null) return
        try {
            ContextCompat.startForegroundService(context, Intent(context, SecurityCameraService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "Could not arm the security camera: ${e.message}")
        }
    }

    /** FCM `type=remote_camera`. Runs on the FCM worker thread. */
    fun handlePush(context: Context, data: Map<String, String>) {
        val sessionId = data["sessionId"]?.takeIf { SESSION_ID.matches(it) } ?: return
        when (data["action"]) {
            "start" -> {
                if (!isEnabled(context)) {
                    reportBlocking(context, sessionId, "camera_off",
                        "Security camera is off on this phone. Turn it on in Gabay SMS → Settings → Security camera")
                    return
                }
                if (!hasPermission(context)) {
                    reportBlocking(context, sessionId, "camera_off",
                        "Camera permission is missing. Turn Security camera on again in Gabay SMS settings")
                    return
                }
                val service = SecurityCameraService.instance
                if (service == null) {
                    reportBlocking(context, sessionId, "camera_off",
                        "The phone's camera service is not running. Open Gabay SMS on the phone once to re-arm it")
                    return
                }
                service.startSession(sessionId)
            }
            "stop" -> SecurityCameraService.instance?.stopSession(sessionId)
        }
    }

    fun reportBlocking(context: Context, sessionId: String, state: String, message: String? = null) {
        runBlocking { report(context, sessionId, state, message) }
    }

    suspend fun report(context: Context, sessionId: String, state: String, message: String? = null) {
        val (deviceId, apiKey) = RemoteScreen.credentials(context) ?: return
        withTimeoutOrNull(8_000) {
            try {
                RemoteScreenApi.get().reportCameraStatus(
                    deviceId, apiKey, RemoteScreenStatusRequest(sessionId, state, message)
                )
            } catch (e: Exception) {
                Log.w(TAG, "Could not report camera status $state: ${e.message}")
            }
        }
    }
}

class SecurityCameraService : Service() {

    companion object {
        private const val TAG = "SecurityCameraService"
        private const val CHANNEL = "security_camera_v1"
        private const val NOTIFICATION_ID = 7361
        private const val MAX_SESSION_MS = 30 * 60_000L
        private const val KEEPALIVE_MS = 2_000L
        private const val UPLOAD_WORKERS = 2
        private const val MAX_UPLOAD_FAILURES = 20

        @Volatile
        var instance: SecurityCameraService? = null
            private set
    }

    private val crashGuard = CoroutineExceptionHandler { _, e ->
        Log.e(TAG, "Camera session failed: ${e.message}", e)
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + crashGuard)
    private var sessionJob: Job? = null
    @Volatile private var sessionId: String? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startQuietForeground()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startQuietForeground()
        return START_STICKY
    }

    override fun onDestroy() {
        endSession()
        instance = null
        scope.cancel()
        super.onDestroy()
    }

    /** Minimal, silent notification: Android requires one for camera services. */
    private fun startQuietForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Background service", NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
            )
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Gabay SMS")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Started from the background on Android 14+: not allowed for camera.
            Log.w(TAG, "Camera service could not enter the foreground: ${e.message}")
            stopSelf()
        }
    }

    @Synchronized
    fun startSession(id: String) {
        if (sessionId == id && sessionJob?.isActive == true) return
        sessionJob?.cancel()
        sessionId = id
        sessionJob = scope.launch { runSession(id) }
    }

    @Synchronized
    fun stopSession(id: String) {
        if (sessionId == id) endSession()
    }

    @Synchronized
    private fun endSession() {
        sessionJob?.cancel()
        sessionJob = null
        sessionId = null
        releaseWakeLock()
    }

    private suspend fun runSession(id: String) {
        val (deviceId, apiKey) = RemoteScreen.credentials(this) ?: return
        acquireWakeLock()
        val api = RemoteScreenApi.get()
        var streamer: CameraStreamer? = null
        try {
            coroutineScope {
                launch { SecurityCamera.report(this@SecurityCameraService, id, "connecting") }
                val alive = AtomicBoolean(true)
                val frames = Channel<EncodedFrame>(Channel.CONFLATED)
                val seq = AtomicLong(0)
                val deadline = SystemClock.elapsedRealtime() + MAX_SESSION_MS
                fun running() = alive.get() && sessionId == id &&
                    SystemClock.elapsedRealtime() < deadline

                suspend fun openCamera(): Boolean {
                    streamer?.close()
                    val next = CameraStreamer(
                        this@SecurityCameraService,
                        SecurityCamera.isBackCamera(this@SecurityCameraService),
                        { SecurityCamera.extraRotation(this@SecurityCameraService) }
                    ) { frames.trySend(it) }
                    streamer = next
                    val error = next.open() ?: return true
                    SecurityCamera.report(this@SecurityCameraService, id, "capture_failed", error)
                    return false
                }
                if (!openCamera()) return@coroutineScope

                // Viewer input: switch camera / rotate picture.
                launch {
                    while (isActive && running()) {
                        val reply = try {
                            val response = api.pollCameraCommands(deviceId, apiKey, id)
                            if (response.isSuccessful) response.body()?.data else null
                        } catch (e: Exception) {
                            null
                        }
                        if (reply == null) {
                            delay(1_000)
                            continue
                        }
                        if (!reply.active) {
                            alive.set(false)
                            break
                        }
                        for (command in reply.commands.orEmpty()) {
                            if (command.type != "camera") continue
                            when (command.action) {
                                "switch" -> {
                                    SecurityCamera.toggleCamera(this@SecurityCameraService)
                                    if (!openCamera()) alive.set(false)
                                }
                                "rotate" -> SecurityCamera.rotate(this@SecurityCameraService)
                            }
                        }
                    }
                }

                // Two uploads in flight: the frame rate isn't capped by one round trip.
                repeat(UPLOAD_WORKERS) {
                    launch {
                        var failures = 0
                        var lastSentAt = SystemClock.elapsedRealtime()
                        while (isActive && running()) {
                            val frame = withTimeoutOrNull(KEEPALIVE_MS) { frames.receive() }
                            if (frame == null && SystemClock.elapsedRealtime() - lastSentAt < KEEPALIVE_MS) continue
                            val body = if (frame != null) RemoteScreenFrameRequest(
                                sessionId = id,
                                width = frame.width,
                                height = frame.height,
                                image = Base64.encodeToString(frame.jpeg, Base64.NO_WRAP),
                                seq = seq.incrementAndGet()
                            ) else RemoteScreenFrameRequest(sessionId = id)
                            var failure: String? = null
                            val reply: RemoteScreenFrameData? = try {
                                val response = api.uploadCameraFrame(deviceId, apiKey, body)
                                if (response.isSuccessful) response.body()?.data
                                else null.also { failure = "HTTP ${response.code()}" }
                            } catch (e: Exception) {
                                failure = e.javaClass.simpleName
                                null
                            }
                            if (reply == null) {
                                failures++
                                if (failures == 3) {
                                    SecurityCamera.report(this@SecurityCameraService, id, "upload_failed", failure)
                                }
                                if (failures >= MAX_UPLOAD_FAILURES) {
                                    alive.set(false)
                                    break
                                }
                                delay(1_000)
                                continue
                            }
                            failures = 0
                            lastSentAt = SystemClock.elapsedRealtime()
                            if (!reply.active) {
                                alive.set(false)
                                break
                            }
                        }
                    }
                }

                while (running()) delay(250)
                coroutineContext.cancelChildren()
            }
        } finally {
            streamer?.close()
            synchronized(this) {
                if (sessionId == id) {
                    sessionId = null
                    releaseWakeLock()
                }
            }
        }
    }

    /** Keep the CPU awake while streaming; the screen can stay off. */
    private fun acquireWakeLock() {
        releaseWakeLock()
        val power = getSystemService(PowerManager::class.java) ?: return
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GabaySMS:SecurityCamera").apply {
            setReferenceCounted(false)
            acquire(MAX_SESSION_MS)
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
    }
}
