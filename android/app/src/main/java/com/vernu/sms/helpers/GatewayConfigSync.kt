package com.vernu.sms.helpers

import android.content.Context
import android.content.Intent
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils

/**
 * Applies server-side gateway config to local prefs so web enable/disable
 * stays in sync with the phone UI and workers.
 */
object GatewayConfigSync {
    private const val TAG = "GatewayConfigSync"

    const val ACTION_GATEWAY_CONFIG_CHANGED = "sms.gabay.online.GATEWAY_CONFIG_CHANGED"

    /**
     * @return true if local gateway enabled flag changed
     */
    @JvmStatic
    fun applyServerEnabled(context: Context, serverEnabled: Boolean): Boolean {
        val appContext = context.applicationContext
        val localEnabled = SharedPreferenceHelper.getSharedPreferenceBoolean(
            appContext, AppConstants.SHARED_PREFS_GATEWAY_ENABLED_KEY, false
        )

        if (localEnabled == serverEnabled) {
            // Still enforce side effects (sticky service / heartbeat) for safety
            applySideEffects(appContext, serverEnabled)
            return false
        }

        Log.i(TAG, "Syncing gateway enabled from server: $localEnabled -> $serverEnabled")
        SharedPreferenceHelper.setSharedPreferenceBoolean(
            appContext, AppConstants.SHARED_PREFS_GATEWAY_ENABLED_KEY, serverEnabled
        )
        applySideEffects(appContext, serverEnabled)
        notifyChanged(appContext)
        return true
    }

    private fun applySideEffects(context: Context, enabled: Boolean) {
        try {
            if (enabled) {
                if (SharedPreferenceHelper.getSharedPreferenceBoolean(
                        context, AppConstants.SHARED_PREFS_STICKY_NOTIFICATION_ENABLED_KEY, false
                    )
                ) {
                    TextBeeUtils.startStickyNotificationService(context)
                }
                // Always keep heartbeat running while registered so remote config can sync
                HeartbeatManager.scheduleHeartbeat(context)
            } else {
                TextBeeUtils.stopStickyNotificationService(context)
                // Keep heartbeat scheduled for config re-sync from web (enable/disable)
                HeartbeatManager.scheduleHeartbeat(context)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to apply gateway side effects: ${e.message}", e)
        }
    }

    @JvmStatic
    fun notifyChanged(context: Context) {
        context.applicationContext.sendBroadcast(
            Intent(ACTION_GATEWAY_CONFIG_CHANGED).setPackage(context.packageName)
        )
    }

    @JvmStatic
    fun isGatewayEnabled(context: Context): Boolean {
        return SharedPreferenceHelper.getSharedPreferenceBoolean(
            context, AppConstants.SHARED_PREFS_GATEWAY_ENABLED_KEY, false
        )
    }
}
