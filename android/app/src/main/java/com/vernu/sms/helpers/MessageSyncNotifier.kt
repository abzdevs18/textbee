package com.vernu.sms.helpers

import android.content.Context
import android.content.Intent

/** Notifies the in-app Messages screen that server-backed history changed. */
object MessageSyncNotifier {
    const val ACTION_MESSAGES_CHANGED = "sms.gabay.online.MESSAGES_CHANGED"

    fun notifyChanged(context: Context) {
        context.applicationContext.sendBroadcast(
            Intent(ACTION_MESSAGES_CHANGED).setPackage(context.packageName)
        )
    }
}
