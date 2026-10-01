package com.vernu.sms.receivers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.os.UserManagerCompat
import com.vernu.sms.outbox.OutboxPollScheduler
import com.vernu.sms.outbox.OutboxSync

/** Periodic outbox pull fired by [OutboxPollScheduler]; reschedules itself. */
class OutboxPollReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "OutboxPollReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != OutboxPollScheduler.ACTION_POLL) return
        val app = context.applicationContext
        // Credential-encrypted storage (prefs, outbox DB) is unavailable until
        // unlock; BOOT_COMPLETED restarts polling afterwards.
        if (!UserManagerCompat.isUserUnlocked(app)) return
        val pending = goAsync()
        OutboxSync.runOnNetworkThread {
            try {
                val result = OutboxSync.claimAndDispatch(app, "poll")
                Log.d(TAG, "Outbox poll: $result")
            } finally {
                OutboxPollScheduler.schedule(app)
                pending.finish()
            }
        }
    }
}
