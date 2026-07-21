package com.vernu.sms.workers

import android.content.Context
import android.util.Log
import androidx.work.*
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.helpers.SMSHelper
import com.vernu.sms.helpers.SimFailoverManager
import com.vernu.sms.helpers.SharedPreferenceHelper

class SmsSendWorker(context: Context, workerParams: WorkerParameters) : Worker(context, workerParams) {
    companion object {
        private const val TAG = "SmsSendWorker"
        private const val QUEUE_NAME = "sms_send_queue"

        const val KEY_PHONE = "phone"
        const val KEY_MESSAGE = "message"
        const val KEY_SMS_ID = "sms_id"
        const val KEY_SMS_BATCH_ID = "sms_batch_id"
        const val KEY_SIM_SUBSCRIPTION_ID = "sim_subscription_id"
        const val KEY_EXPIRES_AT = "expires_at"

        fun enqueue(
            context: Context, phone: String, message: String,
            smsId: String?, smsBatchId: String?, simSubscriptionId: Int?,
            expiresAt: String? = null
        ) {
            val inputData = Data.Builder()
                .putString(KEY_PHONE, phone)
                .putString(KEY_MESSAGE, message)
                .putString(KEY_SMS_ID, smsId)
                .putString(KEY_SMS_BATCH_ID, smsBatchId)
                .putInt(KEY_SIM_SUBSCRIPTION_ID, simSubscriptionId ?: -1)
                .putString(KEY_EXPIRES_AT, expiresAt)
                .build()

            val workRequest = OneTimeWorkRequest.Builder(SmsSendWorker::class.java)
                .setInputData(inputData)
                .build()

            WorkManager.getInstance(context)
                .beginUniqueWork(QUEUE_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, workRequest)
                .enqueue()

            Log.d(TAG, "SMS enqueued for sending - ID: $smsId, Phone: $phone")
        }
    }

    override fun doWork(): Result {
        val phone = inputData.getString(KEY_PHONE)
        val message = inputData.getString(KEY_MESSAGE)
        val smsId = inputData.getString(KEY_SMS_ID)
        val smsBatchId = inputData.getString(KEY_SMS_BATCH_ID)
        val simSubscriptionId = inputData.getInt(KEY_SIM_SUBSCRIPTION_ID, -1)
        val expiresAt = inputData.getString(KEY_EXPIRES_AT)

        if (phone == null || message == null || smsId == null) {
            Log.e(TAG, "Missing required parameters")
            return Result.failure()
        }

        val context = applicationContext

        // Hard 2h policy: never send expired outbox SMS
        if (isExpired(expiresAt)) {
            Log.w(TAG, "SMS $smsId expired (expiresAt=$expiresAt); refusing send")
            SMSHelper.reportExpired(context, smsId, smsBatchId ?: "")
            return Result.success()
        }

        val requestedSim = resolveRequestedSim(context, simSubscriptionId)
        val resolvedSim = SimFailoverManager.resolveSendSim(context, requestedSim, smsBatchId)

        if (resolvedSim != null) {
            SMSHelper.sendSMSFromSpecificSim(
                phone,
                message,
                resolvedSim,
                smsId,
                smsBatchId ?: "",
                context,
                requestedSim
            )
        } else {
            SMSHelper.sendSMS(phone, message, smsId, smsBatchId ?: "", context)
        }

        val delaySeconds = SharedPreferenceHelper.getSharedPreferenceInt(
            context, AppConstants.SHARED_PREFS_SMS_SEND_DELAY_SECONDS_KEY,
            AppConstants.DEFAULT_SMS_SEND_DELAY_SECONDS
        ).coerceIn(0, 3600)

        if (delaySeconds > 0) {
            try {
                Thread.sleep(delaySeconds * 1000L)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }

        return Result.success()
    }

    private fun resolveRequestedSim(context: Context, backendSimId: Int): Int? {
        if (backendSimId != -1 && TextBeeUtils.isValidSubscriptionId(context, backendSimId)) {
            Log.d(TAG, "Using backend-provided SIM subscription ID: $backendSimId")
            return backendSimId
        }

        val preferredSim = SharedPreferenceHelper.getSharedPreferenceInt(
            context, AppConstants.SHARED_PREFS_PREFERRED_SIM_KEY, -1
        )
        if (preferredSim != -1 && TextBeeUtils.isValidSubscriptionId(context, preferredSim)) {
            Log.d(TAG, "Using app-preferred SIM subscription ID: $preferredSim")
            return preferredSim
        }

        return null
    }

    private fun isExpired(expiresAt: String?): Boolean {
        if (expiresAt.isNullOrBlank()) return false
        return try {
            val patterns = arrayOf(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.SSSX",
                "yyyy-MM-dd'T'HH:mm:ssX"
            )
            for (pattern in patterns) {
                try {
                    val sdf = java.text.SimpleDateFormat(pattern, java.util.Locale.US)
                    sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
                    val date = sdf.parse(expiresAt) ?: continue
                    return System.currentTimeMillis() > date.time
                } catch (_: Exception) {
                }
            }
            val millis = expiresAt.toLongOrNull()
            millis != null && System.currentTimeMillis() > millis
        } catch (_: Exception) {
            false
        }
    }
}
