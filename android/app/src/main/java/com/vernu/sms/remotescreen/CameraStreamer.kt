package com.vernu.sms.remotescreen

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Range
import android.util.Size
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

/**
 * Camera2 preview stream -> small JPEG frames (~8 fps). Runs on its own thread;
 * frames are handed to [onFrame] and dropped if the caller is still busy.
 */
class CameraStreamer(
    private val context: Context,
    private val backFacing: Boolean,
    /** Extra rotation chosen in the viewer, for however the phone is mounted. */
    private val extraRotation: () -> Int,
    private val onFrame: (EncodedFrame) -> Unit
) {
    companion object {
        private const val TAG = "CameraStreamer"
        private const val FRAME_INTERVAL_MS = 120L
        private const val JPEG_QUALITY = 60
        private val TARGET = Size(640, 480)

        /** Picks the largest size no wider than 640 (falls back to the smallest). */
        fun chooseSize(sizes: List<Size>): Size? {
            if (sizes.isEmpty()) return null
            val fitting = sizes.filter { it.width <= TARGET.width && it.height <= TARGET.width }
            return (fitting.maxByOrNull { it.width * it.height }
                ?: sizes.minByOrNull { it.width * it.height })
        }

        /** NV21 bytes from a YUV_420_888 image, honouring row/pixel strides. */
        fun toNv21(image: Image): ByteArray {
            val width = image.width
            val height = image.height
            val out = ByteArray(width * height * 3 / 2)
            val y = image.planes[0]
            val yBuf = y.buffer
            var pos = 0
            for (row in 0 until height) {
                yBuf.position(row * y.rowStride)
                yBuf.get(out, pos, width)
                pos += width
            }
            val u = image.planes[1]
            val v = image.planes[2]
            val uBuf = u.buffer
            val vBuf = v.buffer
            for (row in 0 until height / 2) {
                for (col in 0 until width / 2) {
                    out[pos++] = vBuf.get(row * v.rowStride + col * v.pixelStride)
                    out[pos++] = uBuf.get(row * u.rowStride + col * u.pixelStride)
                }
            }
            return out
        }
    }

    private val thread = HandlerThread("GabayCamera").apply { start() }
    private val handler = Handler(thread.looper)
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var sensorOrientation = 0
    @Volatile private var lastFrameAt = 0L
    @Volatile private var busy = false

    /** Opens the camera; returns an error message, or null on success. */
    @SuppressLint("MissingPermission")
    suspend fun open(): String? {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val ids = try {
            manager.cameraIdList.toList()
        } catch (e: Exception) {
            return "The phone's camera is not available"
        }
        val wanted = if (backFacing) CameraCharacteristics.LENS_FACING_BACK
        else CameraCharacteristics.LENS_FACING_FRONT
        val id = ids.firstOrNull {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == wanted
        } ?: ids.firstOrNull() ?: return "This phone has no camera"
        val chars = manager.getCameraCharacteristics(id)
        sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val size = chooseSize(map?.getOutputSizes(ImageFormat.YUV_420_888)?.toList().orEmpty())
            ?: return "The camera has no usable preview size"

        val imageReader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2)
        reader = imageReader
        imageReader.setOnImageAvailableListener({ r ->
            val image = try { r.acquireLatestImage() } catch (e: Exception) { null } ?: return@setOnImageAvailableListener
            try {
                val now = SystemClock.elapsedRealtime()
                if (busy || now - lastFrameAt < FRAME_INTERVAL_MS) return@setOnImageAvailableListener
                lastFrameAt = now
                busy = true
                try {
                    onFrame(encode(image))
                } finally {
                    busy = false
                }
            } catch (e: Exception) {
                Log.w(TAG, "Frame encode failed: ${e.message}")
            } finally {
                image.close()
            }
        }, handler)

        val opened = withTimeoutOrNull(6_000) {
            suspendCancellableCoroutine<Any> { cont ->
                try {
                    manager.openCamera(id, object : CameraDevice.StateCallback() {
                        override fun onOpened(camera: CameraDevice) {
                            if (cont.isActive) cont.resume(camera) else camera.close()
                        }

                        override fun onDisconnected(camera: CameraDevice) {
                            camera.close()
                            if (cont.isActive) cont.resume("The camera was taken by another app (is Iriun or a camera app open?)")
                        }

                        override fun onError(camera: CameraDevice, error: Int) {
                            camera.close()
                            if (cont.isActive) cont.resume(
                                when (error) {
                                    ERROR_CAMERA_IN_USE, ERROR_MAX_CAMERAS_IN_USE ->
                                        "The camera is in use by another app (is Iriun or a camera app open?)"
                                    ERROR_CAMERA_DISABLED ->
                                        "Android blocked the camera. Open Gabay SMS on the phone once to re-arm it"
                                    else -> "The camera failed to open (error $error)"
                                }
                            )
                        }
                    }, handler)
                } catch (e: SecurityException) {
                    if (cont.isActive) cont.resume("Camera permission is missing. Turn Security camera on again in Gabay SMS settings")
                } catch (e: Exception) {
                    if (cont.isActive) cont.resume("The camera failed to open: ${e.message}")
                }
            }
        } ?: return "The camera did not respond"
        if (opened is String) return opened
        val camera = opened as CameraDevice
        device = camera

        val configured = withTimeoutOrNull(6_000) {
            suspendCancellableCoroutine<CameraCaptureSession?> { cont ->
                try {
                    @Suppress("DEPRECATION")
                    camera.createCaptureSession(listOf(imageReader.surface),
                        object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(s: CameraCaptureSession) {
                                if (cont.isActive) cont.resume(s)
                            }

                            override fun onConfigureFailed(s: CameraCaptureSession) {
                                if (cont.isActive) cont.resume(null)
                            }
                        }, handler)
                } catch (e: Exception) {
                    if (cont.isActive) cont.resume(null)
                }
            }
        } ?: return "The camera could not start streaming"
        session = configured
        return try {
            val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(imageReader.surface)
                set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                lowFpsRange(chars)?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
            }.build()
            configured.setRepeatingRequest(request, null, handler)
            null
        } catch (e: Exception) {
            "The camera could not start streaming: ${e.message}"
        }
    }

    /** Lowest standard range (e.g. 15 fps): less heat, better low-light exposure. */
    private fun lowFpsRange(chars: CameraCharacteristics): Range<Int>? =
        chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            ?.filter { it.upper >= 10 }
            ?.minWithOrNull(compareBy({ it.upper }, { -it.lower }))

    private fun encode(image: Image): EncodedFrame {
        val width = image.width
        val height = image.height
        val nv21 = toNv21(image)
        val out = ByteArrayOutputStream(48 * 1024)
        YuvImage(nv21, ImageFormat.NV21, width, height, null)
            .compressToJpeg(Rect(0, 0, width, height), JPEG_QUALITY, out)
        val rotation = ((sensorOrientation + extraRotation()) % 360 + 360) % 360
        if (rotation == 0) return EncodedFrame(out.toByteArray(), width, height)
        val bitmap = BitmapFactory.decodeByteArray(out.toByteArray(), 0, out.size())
        val rotated = Bitmap.createBitmap(
            bitmap, 0, 0, bitmap.width, bitmap.height,
            Matrix().apply { postRotate(rotation.toFloat()) }, true
        )
        bitmap.recycle()
        val rotatedOut = ByteArrayOutputStream(48 * 1024)
        rotated.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, rotatedOut)
        val frame = EncodedFrame(rotatedOut.toByteArray(), rotated.width, rotated.height)
        rotated.recycle()
        return frame
    }

    fun close() {
        try { session?.close() } catch (_: Exception) {}
        try { device?.close() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        session = null
        device = null
        reader = null
        thread.quitSafely()
    }
}
