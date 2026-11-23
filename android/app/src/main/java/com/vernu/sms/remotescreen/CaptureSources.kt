package com.vernu.sms.remotescreen

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import androidx.annotation.RequiresApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import kotlin.coroutines.resume

class EncodedFrame(val jpeg: ByteArray, val width: Int, val height: Int)

sealed class CaptureResult {
    class Frame(val frame: EncodedFrame) : CaptureResult()
    /** Nothing new since the last capture (projection only renders on change). */
    object Unchanged : CaptureResult()
    object Failed : CaptureResult()
}

/** Where frames come from. Coordinates for taps map onto [screenWidth]x[screenHeight]. */
interface CaptureSource {
    /** Android throttles accessibility screenshots; don't ask faster than this. */
    val minIntervalMs: Long
    val screenWidth: Int
    val screenHeight: Int
    suspend fun capture(): CaptureResult
    fun close()
}

private const val JPEG_QUALITY = 50

internal fun encodeJpeg(bitmap: Bitmap): EncodedFrame {
    val (w, h) = RemoteScreenGeometry.scaledSize(bitmap.width, bitmap.height)
    val scaled = if (w == bitmap.width && h == bitmap.height) bitmap
    else Bitmap.createScaledBitmap(bitmap, w, h, true)
    val out = ByteArrayOutputStream(48 * 1024)
    scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
    if (scaled !== bitmap) scaled.recycle()
    return EncodedFrame(out.toByteArray(), w, h)
}

/**
 * Android 11+: AccessibilityService.takeScreenshot. Needs no per-session
 * consent, but Android limits it to ~3/s (Android 12+) or 1/s (Android 11).
 */
@RequiresApi(Build.VERSION_CODES.R)
class AccessibilityCaptureSource(
    private val service: AccessibilityService,
    private val executor: Executor
) : CaptureSource {
    override val minIntervalMs: Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 340L else 1_010L
    @Volatile override var screenWidth = 0
        private set
    @Volatile override var screenHeight = 0
        private set

    override suspend fun capture(): CaptureResult =
        withTimeoutOrNull(5_000) { takeOnce() } ?: CaptureResult.Failed

    private suspend fun takeOnce(): CaptureResult = suspendCancellableCoroutine { cont ->
        try {
            service.takeScreenshot(Display.DEFAULT_DISPLAY, executor,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        val frame = try {
                            encode(result)
                        } catch (e: Exception) {
                            Log.w("RemoteScreen", "Could not encode screenshot: ${e.message}")
                            null
                        }
                        if (cont.isActive) cont.resume(frame?.let { CaptureResult.Frame(it) } ?: CaptureResult.Failed)
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.d("RemoteScreen", "takeScreenshot failed: $errorCode")
                        if (cont.isActive) cont.resume(CaptureResult.Failed)
                    }
                })
        } catch (e: Exception) {
            if (cont.isActive) cont.resume(CaptureResult.Failed)
        }
    }

    private fun encode(result: AccessibilityService.ScreenshotResult): EncodedFrame? {
        val buffer = result.hardwareBuffer
        try {
            val hardware = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: return null
            screenWidth = hardware.width
            screenHeight = hardware.height
            val software = hardware.copy(Bitmap.Config.ARGB_8888, false)
            hardware.recycle()
            return encodeJpeg(software).also { software.recycle() }
        } finally {
            buffer.close()
        }
    }

    override fun close() = Unit
}

/**
 * Android 7–10: MediaProjection mirrored into a small virtual display. Frames
 * arrive only when the screen changes, at whatever rate we read them.
 */
class ProjectionCaptureSource(
    context: Context,
    private val projection: MediaProjection
) : CaptureSource {
    override val minIntervalMs = 200L
    override val screenWidth: Int
    override val screenHeight: Int
    private val width: Int
    private val height: Int
    private val reader: ImageReader
    private val display: VirtualDisplay

    init {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
            .defaultDisplay.getRealMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        val (w, h) = RemoteScreenGeometry.scaledSize(screenWidth, screenHeight)
        width = w
        height = h
        @SuppressLint("WrongConstant")
        val imageReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader = imageReader
        val dpi = maxOf(1, metrics.densityDpi * w / maxOf(1, screenWidth))
        display = projection.createVirtualDisplay(
            "GabayRemoteScreen", w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.surface, null, null
        )
    }

    override suspend fun capture(): CaptureResult = withContext(Dispatchers.IO) {
        val image = try {
            reader.acquireLatestImage()
        } catch (e: Exception) {
            return@withContext CaptureResult.Failed
        } ?: return@withContext CaptureResult.Unchanged
        try {
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowPadding = plane.rowStride - pixelStride * width
            val padded = Bitmap.createBitmap(
                width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888
            )
            padded.copyPixelsFromBuffer(plane.buffer)
            val bitmap = if (padded.width == width) padded
            else Bitmap.createBitmap(padded, 0, 0, width, height).also { padded.recycle() }
            CaptureResult.Frame(encodeJpeg(bitmap).also { bitmap.recycle() })
        } catch (e: Exception) {
            Log.w("RemoteScreen", "Could not read projection frame: ${e.message}")
            CaptureResult.Failed
        } finally {
            image.close()
        }
    }

    override fun close() {
        try { display.release() } catch (_: Exception) {}
        try { reader.close() } catch (_: Exception) {}
        try { projection.stop() } catch (_: Exception) {}
    }
}
