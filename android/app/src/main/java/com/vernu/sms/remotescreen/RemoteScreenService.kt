package com.vernu.sms.remotescreen

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import com.vernu.sms.ApiManagerKt
import com.vernu.sms.dtos.RemoteScreenCommand
import com.vernu.sms.dtos.RemoteScreenFrameData
import com.vernu.sms.dtos.RemoteScreenFrameRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * Captures the screen and performs remote taps while a dashboard viewer is
 * open. Idle otherwise: no events are read and nothing is captured.
 */
class RemoteScreenService : AccessibilityService() {

    companion object {
        private const val TAG = "RemoteScreenService"
        private const val FRAME_INTERVAL_MS = 700L
        private const val AFTER_INPUT_DELAY_MS = 350L
        private const val JPEG_QUALITY = 55
        private const val MAX_SESSION_MS = 30 * 60_000L
        private const val MAX_CAPTURE_FAILURES = 10
        private const val MAX_UPLOAD_FAILURES = 20

        @Volatile
        var instance: RemoteScreenService? = null
            private set
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val captureExecutor = Executors.newSingleThreadExecutor()
    private var sessionJob: Job? = null
    @Volatile private var sessionId: String? = null
    private var wakeLock: PowerManager.WakeLock? = null

    /** Full-resolution size of the last capture; viewer coordinates map onto this. */
    @Volatile private var screenWidth = 0
    @Volatile private var screenHeight = 0

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
        if (!RemoteScreen.isSupported()) return
        if (sessionId == id && sessionJob?.isActive == true) return
        sessionJob?.cancel()
        sessionId = id
        sessionJob = scope.launch {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) runSession(id)
        }
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

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun runSession(id: String) {
        val (deviceId, apiKey) = RemoteScreen.credentials(this) ?: run {
            Log.w(TAG, "Remote screen requested before the device is registered")
            return
        }
        Log.i(TAG, "Remote screen session started")
        acquireWakeLock()
        val api = ApiManagerKt.getApiService()
        val deadline = SystemClock.elapsedRealtime() + MAX_SESSION_MS
        var captureFailures = 0
        var uploadFailures = 0
        var lastDigest: ByteArray? = null
        try {
            while (currentCoroutineContext().isActive && sessionId == id && SystemClock.elapsedRealtime() < deadline) {
                val loopStart = SystemClock.elapsedRealtime()
                val frame = capture()
                if (frame == null) {
                    captureFailures++
                    if (captureFailures >= MAX_CAPTURE_FAILURES) {
                        RemoteScreen.reportStatus(this, id, "capture_failed", "The phone could not take screenshots")
                        break
                    }
                    delay(1_000)
                    continue
                }
                captureFailures = 0

                // Identical JPEG bytes = unchanged screen: send a keep-alive only.
                val digest = MessageDigest.getInstance("SHA-256").digest(frame.jpeg)
                val changed = lastDigest == null || !digest.contentEquals(lastDigest)
                val body = if (changed) {
                    RemoteScreenFrameRequest(
                        sessionId = id,
                        width = frame.width,
                        height = frame.height,
                        image = Base64.encodeToString(frame.jpeg, Base64.NO_WRAP)
                    )
                } else {
                    RemoteScreenFrameRequest(sessionId = id)
                }

                var failure: String? = null
                val reply: RemoteScreenFrameData? = try {
                    val response = api.uploadRemoteScreenFrame(deviceId, apiKey, body)
                    if (response.isSuccessful) response.body()?.data
                    else null.also { failure = "HTTP ${response.code()}" }
                } catch (e: Exception) {
                    Log.w(TAG, "Frame upload failed: ${e.message}")
                    failure = e.javaClass.simpleName
                    null
                }
                if (reply == null) {
                    uploadFailures++
                    // Tell the viewer once instead of failing silently.
                    if (uploadFailures == 3) {
                        RemoteScreen.reportStatus(this, id, "upload_failed", failure)
                    }
                    if (uploadFailures >= MAX_UPLOAD_FAILURES) break
                    delay(1_500)
                    continue
                }
                uploadFailures = 0
                if (changed) lastDigest = digest
                if (!reply.active) break

                val commands = reply.commands.orEmpty()
                for (command in commands.take(20)) perform(command)

                val pause = if (commands.isNotEmpty()) AFTER_INPUT_DELAY_MS else FRAME_INTERVAL_MS
                val elapsed = SystemClock.elapsedRealtime() - loopStart
                delay((pause - elapsed).coerceAtLeast(if (commands.isNotEmpty()) pause else 0L))
            }
        } finally {
            Log.i(TAG, "Remote screen session ended")
            synchronized(this) {
                if (sessionId == id) {
                    sessionId = null
                    releaseWakeLock()
                }
            }
        }
    }

    private class Frame(val jpeg: ByteArray, val width: Int, val height: Int)

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun capture(): Frame? = suspendCancellableCoroutine { cont ->
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, captureExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val frame = try {
                        encode(result)
                    } catch (e: Exception) {
                        Log.w(TAG, "Could not encode screenshot: ${e.message}")
                        null
                    }
                    if (cont.isActive) cont.resume(frame)
                }

                override fun onFailure(errorCode: Int) {
                    // ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT is expected now and then.
                    Log.d(TAG, "takeScreenshot failed: $errorCode")
                    if (cont.isActive) cont.resume(null)
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "takeScreenshot threw: ${e.message}")
            if (cont.isActive) cont.resume(null)
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun encode(result: ScreenshotResult): Frame? {
        val buffer = result.hardwareBuffer
        try {
            val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: return null
            screenWidth = hardware.width
            screenHeight = hardware.height
            val software = hardware.copy(Bitmap.Config.ARGB_8888, false)
            hardware.recycle()
            val (w, h) = RemoteScreenGeometry.scaledSize(software.width, software.height)
            val scaled = if (w == software.width && h == software.height) software
            else Bitmap.createScaledBitmap(software, w, h, true).also { software.recycle() }
            val out = ByteArrayOutputStream(64 * 1024)
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            scaled.recycle()
            return Frame(out.toByteArray(), w, h)
        } finally {
            buffer.close()
        }
    }

    private suspend fun perform(command: RemoteScreenCommand) {
        val gesture = RemoteScreenGeometry.toGesture(command, screenWidth, screenHeight) ?: run {
            Log.w(TAG, "Ignoring invalid remote command ${command.type}")
            return
        }
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
                is RemoteGesture.Tap -> dispatch(Path().apply { moveTo(gesture.x, gesture.y) }, 60L)
                is RemoteGesture.Swipe -> dispatch(
                    Path().apply {
                        moveTo(gesture.x1, gesture.y1)
                        lineTo(gesture.x2, gesture.y2)
                    },
                    gesture.durationMs
                )
            }
        }
    }

    private suspend fun dispatch(path: Path, durationMs: Long) {
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
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

    /**
     * A gateway phone usually sits with its screen off; a black screenshot is
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
