package com.vernu.sms.remotescreen

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log

/**
 * One-time-provisioned, silent gateway setup.
 *
 * After a single ADB command per phone:
 *   adb shell pm grant sms.gabay.online android.permission.WRITE_SECURE_SETTINGS
 * the app can, every time its process starts:
 *  - switch its own Remote Screen accessibility service on (and back on, when
 *    an OEM like vivo/Xiaomi turns it off after the app is killed), with no
 *    taps on the phone and no "restricted settings" step;
 *  - raise Android's per-app SMS limit, so the "Gabay SMS is sending a large
 *    number of SMS messages — Allow?" prompt stops blocking the outbox.
 *
 * Without the grant every call here is a no-op and the manual Accessibility
 * switch in Settings still works.
 */
object GatewaySystemSetup {
    private const val TAG = "GatewaySystemSetup"

    /** Settings.Global.SMS_OUTGOING_CHECK_MAX_COUNT (hidden API constant). */
    const val SMS_LIMIT_KEY = "sms_outgoing_check_max_count"
    /** Messages per check window (30 min by default) before Android asks. */
    const val SMS_LIMIT_VALUE = 100_000

    fun hasSecureSettingsGrant(context: Context): Boolean =
        context.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) ==
            PackageManager.PERMISSION_GRANTED

    /** Safe to call often: only writes when something is missing. */
    @JvmStatic
    fun ensure(context: Context) {
        if (!hasSecureSettingsGrant(context)) return
        try {
            if (RemoteScreen.isSupported()) ensureRemoteScreenEnabled(context)
            ensureSmsLimitLifted(context)
        } catch (e: Exception) {
            // Never let provisioning break app start.
            Log.w(TAG, "System setup failed: ${e.message}")
        }
    }

    /** True when the service is (now) enabled. */
    fun ensureRemoteScreenEnabled(context: Context): Boolean {
        if (RemoteScreen.isServiceEnabled(context)) return true
        if (!hasSecureSettingsGrant(context)) return false
        return try {
            val resolver = context.contentResolver
            val component = ComponentName(context, RemoteScreenService::class.java)
            val current = Settings.Secure.getString(
                resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ).orEmpty()
            Settings.Secure.putString(
                resolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                mergeEnabledServices(current, component.flattenToString())
            )
            Settings.Secure.putInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            Log.i(TAG, "Remote screen accessibility service enabled")
            true
        } catch (e: Exception) {
            Log.w(TAG, "Could not enable remote screen service: ${e.message}")
            false
        }
    }

    fun smsLimit(context: Context): Int? = try {
        Settings.Global.getString(context.contentResolver, SMS_LIMIT_KEY)?.toIntOrNull()
    } catch (e: Exception) {
        null
    }

    fun isSmsLimitLifted(context: Context): Boolean =
        (smsLimit(context) ?: 0) >= SMS_LIMIT_VALUE

    private fun ensureSmsLimitLifted(context: Context) {
        if (isSmsLimitLifted(context)) return
        Settings.Global.putInt(context.contentResolver, SMS_LIMIT_KEY, SMS_LIMIT_VALUE)
        Log.i(TAG, "Android SMS sending limit raised to $SMS_LIMIT_VALUE")
    }

    /** Adds [flattened] to a ':'-separated service list, keeping the others. Pure. */
    fun mergeEnabledServices(current: String, flattened: String): String {
        val parts = current.split(':').map { it.trim() }.filter { it.isNotEmpty() }
        val target = normalize(flattened)
        if (parts.any { normalize(it) == target }) return parts.joinToString(":")
        return (parts + flattened).joinToString(":")
    }

    /** "pkg/.Cls" and "pkg/pkg.Cls" name the same component. */
    private fun normalize(flattened: String): String {
        val slash = flattened.indexOf('/')
        if (slash <= 0) return flattened
        val pkg = flattened.substring(0, slash)
        val cls = flattened.substring(slash + 1)
        return "$pkg/" + if (cls.startsWith(".")) pkg + cls else cls
    }
}
