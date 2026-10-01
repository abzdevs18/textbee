package com.vernu.sms.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.vernu.sms.R
import com.vernu.sms.helpers.GatewayReliability
import com.vernu.sms.outbox.OutboxPollScheduler
import com.vernu.sms.outbox.SmsDispatcher
import com.vernu.sms.ui.splash.SplashActivity

/**
 * Keep-alive foreground service. A gateway phone sits idle with the screen
 * off; without a foreground service, OEM battery managers kill the process
 * and FCM commands are dropped before the app ever sees them.
 */
class StickyNotificationService : Service() {
    companion object {
        private const val TAG = "StickyNotifService"
        private const val NOTIFICATION_CHANNEL_ID = "gateway_keepalive"
        private const val NOTIFICATION_ID = 1
    }

    override fun onBind(intent: Intent): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground must come first on every start: a service launched
        // with startForegroundService() that stops before calling it crashes.
        val inForeground = try {
            startInForeground()
            true
        } catch (e: Exception) {
            Log.w(TAG, "Cannot enter foreground (likely a background-start restriction): ${e.message}")
            false
        }

        if (!inForeground || !GatewayReliability.isKeepAliveEnabled(applicationContext)) {
            if (inForeground) stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        // While we are up, nothing should wait on a deferred job.
        SmsDispatcher.kick(applicationContext)
        OutboxPollScheduler.schedule(applicationContext)
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "StickyNotificationService destroyed")
    }

    private fun startInForeground() {
        val notification = createNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }

    private fun createNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager =
                getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID, "Gateway status", NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps Gabay SMS ready to send messages in the background"
                enableVibration(false)
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(channel)
        }

        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, SplashActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Gabay SMS is active")
            .setContentText("Ready to send SMS from this phone")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSmallIcon(R.mipmap.ic_launcher)
            .build()
    }
}
