package com.vernu.sms.helpers

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.vernu.sms.AppConstants
import com.vernu.sms.ui.splash.SplashActivity

/** General service alerts, independent of the SMS gateway on/off switch and modem queue. */
object ServiceAlertNotifications {
    const val CHANNEL_ID = "service_alerts_v1"
    private const val PREFS = "service_alert_notifications"

    @JvmStatic
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
            val channel = NotificationChannel(CHANNEL_ID, "Service alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Module degradation, service disruptions and recovery"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 300, 150, 300)
                setSound(sound, attributes)
                lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
            }
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    @JvmStatic
    fun requestPermission(activity: Activity) {
        ensureChannel(activity)
        if (SharedPreferenceHelper.getSharedPreferenceString(activity, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, "").isNullOrBlank()) return
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("permission_requested", false) &&
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            prefs.edit().putBoolean("permission_requested", true).apply()
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9113)
        }
    }

    fun openSettings(context: Context) {
        ensureChannel(context)
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_ID)
        } else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @Synchronized
    fun show(context: Context, data: Map<String, String>): Boolean {
        val now = System.currentTimeMillis()
        val alert = PlatformAlertPayload.parse(data, now) ?: return false
        // Disconnecting the device also stops owner alerts from old in-flight FCM messages.
        if (SharedPreferenceHelper.getSharedPreferenceString(context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, "").isNullOrBlank()) return false
        ensureChannel(context)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val recent = (prefs.getStringSet("displayed", emptySet()) ?: emptySet())
            .filter { (it.substringBefore('|').toLongOrNull() ?: 0) >= now - 86400000 }
        if (recent.any { it.substringAfter('|') == alert.id }) return false
        val intent = alert.url?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)) }
            ?: Intent(context, SplashActivity::class.java)
        val notificationId = (alert.id.hashCode() and 0x0fffffff) + 1000
        val pending = PendingIntent.getActivity(context, notificationId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setColor(Color.rgb(61, 130, 22))
            .setContentTitle(alert.title).setContentText(alert.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId, notification)
        val bounded = recent.sortedByDescending { it.substringBefore('|').toLongOrNull() ?: 0 }.take(199).toMutableSet()
        bounded.add("$now|${alert.id}")
        prefs.edit().putStringSet("displayed", bounded).apply()
        return true
    }
}
