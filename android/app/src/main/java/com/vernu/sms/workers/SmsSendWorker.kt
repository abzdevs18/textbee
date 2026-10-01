package com.vernu.sms.workers

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.vernu.sms.models.SMSPayload
import com.vernu.sms.outbox.SmsDispatcher

/**
 * Legacy (≤ 2.8.19) send job. Kept only so jobs WorkManager persisted before
 * an upgrade still run: they are moved into the durable outbox, which
 * de-duplicates them against anything the server re-sends.
 */
class SmsSendWorker(context: Context, workerParams: WorkerParameters) : Worker(context, workerParams) {
    companion object {
        private const val TAG = "SmsSendWorker"

        const val KEY_PHONE = "phone"
        const val KEY_MESSAGE = "message"
        const val KEY_SMS_ID = "sms_id"
        const val KEY_SMS_BATCH_ID = "sms_batch_id"
        const val KEY_SIM_SUBSCRIPTION_ID = "sim_subscription_id"
        const val KEY_EXPIRES_AT = "expires_at"
    }

    override fun doWork(): Result {
        val phone = inputData.getString(KEY_PHONE)
        val message = inputData.getString(KEY_MESSAGE)
        val smsId = inputData.getString(KEY_SMS_ID)
        if (phone.isNullOrBlank() || message == null || smsId.isNullOrBlank()) {
            Log.w(TAG, "Dropping legacy send job without phone/message/smsId")
            return Result.success()
        }
        if (runAttemptCount > 0) {
            // The old worker sent first and slept afterwards, so a job that was
            // interrupted (e.g. by the upgrade itself) most likely already went
            // out. Its SENT callback still reports it; if not, the server lease
            // expires and the SMS is re-issued to the outbox.
            Log.w(TAG, "Skipping re-run of legacy send job for SMS $smsId to avoid a duplicate")
            return Result.success()
        }

        val payload = SMSPayload().apply {
            this.smsId = smsId
            smsBatchId = inputData.getString(KEY_SMS_BATCH_ID)
            recipients = arrayOf<String?>(phone)
            this.message = message
            simSubscriptionId = inputData.getInt(KEY_SIM_SUBSCRIPTION_ID, -1).takeIf { it >= 0 }
            expiresAt = inputData.getString(KEY_EXPIRES_AT)
        }
        SmsDispatcher.accept(applicationContext, payload, "legacy-worker")
        SmsDispatcher.pump(applicationContext)
        return Result.success()
    }
}
