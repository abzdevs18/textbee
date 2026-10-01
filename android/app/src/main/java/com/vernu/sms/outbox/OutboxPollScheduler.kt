package com.vernu.sms.outbox

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.helpers.GatewayConfigSync
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.receivers.OutboxPollReceiver

/**
 * FCM-independent safety net: while the gateway is on, pull the server outbox
 * every couple of minutes. Uses an allow-while-idle alarm, which Doze still
 * honours (rate-limited) and which briefly grants network access.
 */
object OutboxPollScheduler {
    private const val TAG = "OutboxPollScheduler"
    private const val REQUEST_CODE = 7303
    const val ACTION_POLL = "sms.gabay.online.OUTBOX_POLL"
    const val INTERVAL_MS = 2 * 60 * 1000L

    @JvmStatic
    fun schedule(context: Context) {
        val app = context.applicationContext
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            app, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        if (deviceId.isBlank() || !GatewayConfigSync.isGatewayEnabled(app)) {
            cancel(app)
            return
        }
        val alarmManager = app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val triggerAt = SystemClock.elapsedRealtime() + INTERVAL_MS
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent(app)
                )
            } else {
                alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent(app))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not schedule outbox poll: ${e.message}")
        }
    }

    @JvmStatic
    fun cancel(context: Context) {
        val app = context.applicationContext
        val alarmManager = app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        try {
            alarmManager.cancel(pendingIntent(app))
        } catch (e: Exception) {
            Log.w(TAG, "Could not cancel outbox poll: ${e.message}")
        }
    }

    private fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, OutboxPollReceiver::class.java).setAction(ACTION_POLL)
        return PendingIntent.getBroadcast(
            context, REQUEST_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
