package com.vernu.sms.remotescreen

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.vernu.sms.ApiManagerKt
import com.vernu.sms.AppConstants
import com.vernu.sms.R
import com.vernu.sms.dtos.RemoteScreenCommand
import com.vernu.sms.dtos.RemoteScreenStatusRequest
import com.vernu.sms.helpers.SharedPreferenceHelper
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.roundToInt

/**
 * Remote screen: the dashboard asks (over FCM) to watch this phone, the
 * accessibility service streams screenshots and performs the taps the viewer
 * sends back. Used to approve system prompts — e.g. Android's "sending a large
 * number of SMS messages" confirmation — without someone at the phone.
 */
object RemoteScreen {
    private const val TAG = "RemoteScreen"
    const val NOTIFICATION_CHANNEL_ID = "remote_screen_v1"
    const val NOTIFICATION_ID = 7342
    private val SESSION_ID = Regex("^[a-f0-9]{32}$")

    /** AccessibilityService.takeScreenshot needs Android 11. */
    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    fun isServiceEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val component = ComponentName(context, RemoteScreenService::class.java)
        return enabled.split(':').any {
            ComponentName.unflattenFromString(it) == component
        }
    }

    fun accessibilitySettingsIntent(): Intent =
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Called from FCMService for `type=remote_screen` data messages. */
    fun handlePush(context: Context, data: Map<String, String>) {
        val sessionId = data["sessionId"]
        if (sessionId == null || !SESSION_ID.matches(sessionId)) {
            Log.w(TAG, "Ignoring remote screen push without a valid session id")
            return
        }
        when (data["action"]) {
            "start" -> {
                val service = RemoteScreenService.instance
                when {
                    !isSupported() -> reportStatus(
                        context, sessionId, "unsupported_android",
                        "Android ${Build.VERSION.RELEASE} — remote screen needs Android 11 or newer"
                    )
                    service == null -> reportStatus(
                        context, sessionId, "accessibility_disabled",
                        "Turn on Settings > Accessibility > Gabay SMS remote screen on the phone"
                    )
                    else -> service.startSession(sessionId)
                }
            }
            "stop" -> RemoteScreenService.instance?.stopSession(sessionId)
        }
    }

    /** Blocking; FCM gives us a background thread and ~10s. */
    fun reportStatus(context: Context, sessionId: String, state: String, message: String? = null) {
        val (deviceId, apiKey) = credentials(context) ?: return
        runBlocking {
            withTimeoutOrNull(8_000) {
                try {
                    ApiManagerKt.getApiService().reportRemoteScreenStatus(
                        deviceId, apiKey, RemoteScreenStatusRequest(sessionId, state, message)
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Could not report remote screen status $state: ${e.message}")
                }
            }
        }
    }

    fun credentials(context: Context): Pair<String, String>? {
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""
        if (deviceId.isBlank() || apiKey.isBlank()) return null
        return deviceId to apiKey
    }

    fun showViewingNotification(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID, "Remote screen", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Shown while the dashboard is viewing this screen" }
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Screen is being viewed remotely")
            .setContentText("A Gabay SMS dashboard user is viewing and can tap this screen.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted; streaming still works.
        }
    }

    fun clearViewingNotification(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
}

/** A gesture in screen pixels. Pure so it can be unit-tested. */
sealed class RemoteGesture {
    data class Tap(val x: Float, val y: Float) : RemoteGesture()
    data class Swipe(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val durationMs: Long) : RemoteGesture()
    data class Global(val action: String) : RemoteGesture()
}

object RemoteScreenGeometry {
    private val GLOBAL_ACTIONS = setOf("back", "home", "recents", "notifications")

    private fun px(normalized: Double?, size: Int): Float? {
        if (normalized == null || normalized.isNaN() || normalized < 0.0 || normalized > 1.0) return null
        // Keep inside the screen: a gesture exactly on the edge is rejected by Android.
        return (normalized * size).roundToInt().coerceIn(0, size - 1).toFloat()
    }

    /** Maps a viewer command onto a screen of [width]x[height] pixels; null if invalid. */
    fun toGesture(command: RemoteScreenCommand, width: Int, height: Int): RemoteGesture? {
        if (width <= 0 || height <= 0) return null
        return when (command.type) {
            "tap" -> {
                val x = px(command.x, width) ?: return null
                val y = px(command.y, height) ?: return null
                RemoteGesture.Tap(x, y)
            }
            "swipe" -> {
                val x1 = px(command.x1, width) ?: return null
                val y1 = px(command.y1, height) ?: return null
                val x2 = px(command.x2, width) ?: return null
                val y2 = px(command.y2, height) ?: return null
                RemoteGesture.Swipe(x1, y1, x2, y2, (command.durationMs ?: 300L).coerceIn(50L, 3_000L))
            }
            "global" -> command.action?.takeIf { it in GLOBAL_ACTIONS }?.let { RemoteGesture.Global(it) }
            else -> null
        }
    }

    /** Longest edge of an uploaded frame; enough to read and tap a dialog. */
    const val MAX_FRAME_EDGE = 960

    fun scaledSize(width: Int, height: Int, maxEdge: Int = MAX_FRAME_EDGE): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= maxEdge) return width to height
        val scale = maxEdge.toDouble() / longest
        return maxOf(1, (width * scale).roundToInt()) to maxOf(1, (height * scale).roundToInt())
    }
}
