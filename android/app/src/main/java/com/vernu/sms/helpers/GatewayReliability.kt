package com.vernu.sms.helpers

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.outbox.OutboxPollScheduler
import com.vernu.sms.outbox.SmsDispatcher

/**
 * Keeps every delivery path of the gateway alive: keep-alive foreground
 * service, outbox poll alarm, and a dispatcher kick for anything queued.
 */
object GatewayReliability {
    private const val TAG = "GatewayReliability"

    @JvmStatic
    fun isKeepAliveEnabled(context: Context): Boolean =
        SharedPreferenceHelper.getSharedPreferenceBoolean(
            context,
            AppConstants.SHARED_PREFS_STICKY_NOTIFICATION_ENABLED_KEY,
            AppConstants.DEFAULT_STICKY_NOTIFICATION_ENABLED
        )

    @JvmStatic
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            ?: return true
        return powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * System prompt that exempts the gateway from Doze/app-standby limits. An
     * SMS gateway's core job is to act on server pushes while the screen is off.
     */
    @JvmStatic
    @SuppressLint("BatteryLife")
    fun batteryOptimizationRequestIntent(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))

    /** Fallback when the direct prompt is unavailable on a ROM. */
    @JvmStatic
    fun batteryOptimizationSettingsIntent(): Intent =
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)

    /** App details page, where OEM "autostart"/"background activity" switches usually live. */
    @JvmStatic
    fun appDetailsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.fromParts("package", context.packageName, null))

    /** Idempotent: safe to call from app start, boot, heartbeat and config sync. */
    @JvmStatic
    fun ensureRunning(context: Context, reason: String) {
        val app = context.applicationContext
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            app, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        if (deviceId.isBlank()) return
        try {
            if (GatewayConfigSync.isGatewayEnabled(app)) {
                if (isKeepAliveEnabled(app)) TextBeeUtils.startStickyNotificationService(app)
                OutboxPollScheduler.schedule(app)
            } else {
                OutboxPollScheduler.cancel(app)
            }
            SmsDispatcher.kick(app)
        } catch (e: Exception) {
            Log.e(TAG, "ensureRunning($reason) failed: ${e.message}", e)
        }
    }

    /** Called when the phone is disconnected from the account. */
    @JvmStatic
    fun stopAll(context: Context) {
        val app = context.applicationContext
        OutboxPollScheduler.cancel(app)
        TextBeeUtils.stopStickyNotificationService(app)
    }
}
