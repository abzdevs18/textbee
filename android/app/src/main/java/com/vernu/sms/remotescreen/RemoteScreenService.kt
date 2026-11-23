package com.vernu.sms.remotescreen

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.graphics.Path
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import com.vernu.sms.dtos.RemoteScreenCommand
import com.vernu.sms.dtos.RemoteScreenFrameData
import com.vernu.sms.dtos.RemoteScreenFrameRequest
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
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Hosts remote-screen sessions: captures the screen, uploads changed frames
 * and performs the viewer's taps. Idle otherwise — no events are read and
 * nothing is captured unless a dashboard viewer is open.
 *
 * Three loops run per session so none waits on another:
 *  - capture: grabs the screen as fast as Android allows, keeps only changes;
 *  - upload:  sends the newest frame (or a keep-alive) to the server;
 *  - input:   long-polls the server for taps and runs them immediately.
 */
class RemoteScreenService : AccessibilityService() {

    companion object {
        private const val TAG = "RemoteScreenService"
        private const val MAX_SESSION_MS = 30 * 60_000L
        private const val MAX_CAPTURE_FAILURES = 10
        private const val MAX_UPLOAD_FAILURES = 20
        /** Unchanged screen: how often to look again. */
        private const val IDLE_CHECK_MS = 300L
        /** Unchanged screen: how often to tell the server we're still here. */
        private const val KEEPALIVE_MS = 2_000L
        /** Let the UI react to a tap before capturing it. */
        private const val AFTER_INPUT_SETTLE_MS = 120L

        @Volatile
        var instance: RemoteScreenService? = null
            private set
    }

    // A bug in a session must never take the SMS gateway process down with it.
    private val crashGuard = CoroutineExceptionHandler { _, e ->
        Log.e(TAG, "Remote screen session failed: ${e.message}", e)
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + crashGuard)
    private val captureExecutor = Executors.newSingleThreadExecutor()
    private var sessionJob: Job? = null
    @Volatile private var sessionId: String? = null
    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var source: CaptureSource? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "Remote screen service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        endSession()
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        endSession()
        instance = null
        scope.cancel()
        captureExecutor.shutdownNow()
        super.onDestroy()
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
        val (deviceId, apiKey) = RemoteScreen.credentials(this) ?: run {
            Log.w(TAG, "Remote screen requested before the device is registered")
            return
        }
        Log.i(TAG, "Remote screen session started")
        acquireWakeLock()
        val api = RemoteScreenApi.get()
        var opened: CaptureSource? = null
        try {
            coroutineScope {
                // Don't hold up the first frame for this.
                launch { RemoteScreen.reportStatusAsync(this@RemoteScreenService, id, "connecting") }
                val capture = openCaptureSource(id) ?: return@coroutineScope
                opened = capture
                source = capture

                val alive = AtomicBoolean(true)
                val wake = Channel<Unit>(Channel.CONFLATED)
                val frames = Channel<EncodedFrame>(Channel.CONFLATED)
                val resendLast = AtomicBoolean(false)
                val deadline = SystemClock.elapsedRealtime() + MAX_SESSION_MS
                fun running() = alive.get() && sessionId == id &&
                    SystemClock.elapsedRealtime() < deadline

                // Input: taps arrive the moment the viewer clicks.
                launch {
                    while (isActive && running()) {
                        val reply = try {
                            val response = api.pollCommands(deviceId, apiKey, id)
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
                            wake.trySend(Unit)
                            break
                        }
                        val commands = reply.commands.orEmpty()
                        if (commands.isNotEmpty()) {
                            for (command in commands.take(20)) perform(command)
                            delay(AFTER_INPUT_SETTLE_MS)
                            wake.trySend(Unit)
                        }
                    }
                }

                // Upload: always the newest frame; keep-alive while nothing changes.
                launch {
                    var failures = 0
                    var lastSentAt = 0L
                    while (isActive && running()) {
                        val frame = withTimeoutOrNull(KEEPALIVE_MS) { frames.receive() }
                        if (frame == null && SystemClock.elapsedRealtime() - lastSentAt < KEEPALIVE_MS) continue
                        val body = if (frame != null) RemoteScreenFrameRequest(
                            sessionId = id,
                            width = frame.width,
                            height = frame.height,
                            image = Base64.encodeToString(frame.jpeg, Base64.NO_WRAP)
                        ) else RemoteScreenFrameRequest(sessionId = id)
                        var failure: String? = null
                        val reply: RemoteScreenFrameData? = try {
                            val response = api.uploadFrame(deviceId, apiKey, body)
                            if (response.isSuccessful) response.body()?.data
                            else null.also { failure = "HTTP ${response.code()}" }
                        } catch (e: Exception) {
                            failure = e.javaClass.simpleName
                            null
                        }
                        if (reply == null) {
                            failures++
                            if (frame != null) resendLast.set(true)
                            if (failures == 3) {
                                RemoteScreen.reportStatusAsync(this@RemoteScreenService, id, "upload_failed", failure)
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
                            wake.trySend(Unit)
                            break
                        }
                        // Older servers deliver taps here too.
                        val commands = reply.commands.orEmpty()
                        if (commands.isNotEmpty()) {
                            for (command in commands.take(20)) perform(command)
                            wake.trySend(Unit)
                        }
                    }
                }

                // Capture: as fast as Android allows; only changed frames go on.
                var lastDigest: ByteArray? = null
                var lastFrame: EncodedFrame? = null
                var lastCaptureAt = 0L
                var captureFailures = 0
                while (running()) {
                    val sinceLast = SystemClock.elapsedRealtime() - lastCaptureAt
                    if (sinceLast < capture.minIntervalMs) delay(capture.minIntervalMs - sinceLast)
                    lastCaptureAt = SystemClock.elapsedRealtime()
                    when (val result = capture.capture()) {
                        is CaptureResult.Frame -> {
                            captureFailures = 0
                            val digest = MessageDigest.getInstance("SHA-256").digest(result.frame.jpeg)
                            val changed = lastDigest == null || !digest.contentEquals(lastDigest)
                            if (changed || resendLast.getAndSet(false)) {
                                lastDigest = digest
                                lastFrame = result.frame
                                frames.trySend(result.frame)
                                continue
                            }
                        }
                        CaptureResult.Unchanged -> {
                            captureFailures = 0
                            if (resendLast.getAndSet(false)) lastFrame?.let { frames.trySend(it) }
                        }
                        CaptureResult.Failed -> {
                            captureFailures++
                            if (captureFailures >= MAX_CAPTURE_FAILURES) {
                                RemoteScreen.reportStatusAsync(
                                    this@RemoteScreenService, id, "capture_failed",
                                    "The phone could not capture its screen"
                                )
                                break
                            }
                        }
                    }
                    // Nothing new: look again shortly, or right away after a tap.
                    withTimeoutOrNull(IDLE_CHECK_MS) { wake.receive() }
                }
                alive.set(false)
                coroutineContext.cancelChildren()
            }
        } finally {
            Log.i(TAG, "Remote screen session ended")
            source = null
            opened?.close()
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) RemoteScreenProjection.release(this)
            synchronized(this) {
                if (sessionId == id) {
                    sessionId = null
                    releaseWakeLock()
                }
            }
        }
    }

    private suspend fun openCaptureSource(id: String): CaptureSource? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return AccessibilityCaptureSource(this, captureExecutor)
        }
        val projection = RemoteScreenProjection.obtain(this) {
            RemoteScreen.reportStatusBlocking(this, id, "awaiting_consent")
        }
        if (projection == null) {
            RemoteScreen.reportStatusAsync(
                this, id, "capture_failed",
                "Screen-capture permission was not granted on the phone"
            )
            return null
        }
        return withContext(Dispatchers.Main) { ProjectionCaptureSource(this@RemoteScreenService, projection) }
    }

    private suspend fun perform(command: RemoteScreenCommand) {
        val capture = source ?: return
        val gesture = RemoteScreenGeometry.toGesture(command, capture.screenWidth, capture.screenHeight)
            ?: return
        try {
            withContext(Dispatchers.Main) {
                when (gesture) {
                    is RemoteGesture.Global -> performGlobalAction(
                        when (gesture.action) {
                            "back" -> GLOBAL_ACTION_BACK
                            "home" -> GLOBAL_ACTION_HOME
                            "recents" -> GLOBAL_ACTION_RECENTS
                            else -> GLOBAL_ACTION_NOTIFICATIONS
                        }
                    )
                    is RemoteGesture.Tap -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        dispatch(Path().apply { moveTo(gesture.x, gesture.y) }, 60L)
                    }
                    is RemoteGesture.Swipe -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        dispatch(
                            Path().apply {
                                moveTo(gesture.x1, gesture.y1)
                                lineTo(gesture.x2, gesture.y2)
                            },
                            gesture.durationMs
                        )
                    }
                }
                Unit
            }
        } catch (e: Exception) {
            Log.w(TAG, "Remote input failed: ${e.message}")
        }
    }

    @RequiresApi(Build.VERSION_CODES.N)
    private suspend fun dispatch(path: Path, durationMs: Long) {
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        // Some OEMs never call back; don't let one tap stall the input loop.
        withTimeoutOrNull(durationMs + 1_500) {
            suspendCancellableCoroutine { cont ->
                val accepted = dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        if (cont.isActive) cont.resume(Unit)
                    }

                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        if (cont.isActive) cont.resume(Unit)
                    }
                }, null)
                if (!accepted && cont.isActive) cont.resume(Unit)
            }
        }
    }

    /**
     * A gateway phone usually sits with its screen off; a black screen is
     * useless, so keep the display on while someone is watching.
     */
    @SuppressLint("WakelockTimeout")
    @Suppress("DEPRECATION")
    private fun acquireWakeLock() {
        releaseWakeLock()
        val power = getSystemService(PowerManager::class.java) ?: return
        wakeLock = power.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "GabaySMS:RemoteScreen"
        ).apply {
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
