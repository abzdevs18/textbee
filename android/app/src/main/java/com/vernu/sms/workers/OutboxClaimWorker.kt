package com.vernu.sms.workers

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.vernu.sms.ApiManager
import com.vernu.sms.AppConstants
import com.vernu.sms.dtos.ClaimOutboxRequest
import com.vernu.sms.helpers.GatewayConfigSync
import com.vernu.sms.helpers.SharedPreferenceHelper
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Pulls pending SMS from the central outbox when this device is free.
 * Triggered by FCM `work_available` and after heartbeats.
 */
class OutboxClaimWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        private const val TAG = "OutboxClaimWorker"
        private const val UNIQUE_WORK = "outbox_claim_work"

        fun enqueue(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = OneTimeWorkRequest.Builder(OutboxClaimWorker::class.java)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.KEEP, request)
            Log.d(TAG, "Outbox claim work enqueued")
        }
    }

    override fun doWork(): Result {
        val context = applicationContext
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""

        if (deviceId.isBlank() || apiKey.isBlank()) {
            Log.w(TAG, "Device not registered; skip claim")
            return Result.success()
        }

        if (!GatewayConfigSync.isGatewayEnabled(context)) {
            Log.d(TAG, "Gateway disabled; skip outbox claim")
            return Result.success()
        }

        return try {
            val request = ClaimOutboxRequest().apply { limit = 5 }
            val response = ApiManager.getApiService()
                .claimOutbox(deviceId, apiKey, request)
                .execute()

            if (!response.isSuccessful) {
                Log.e(TAG, "claim-outbox failed: HTTP ${response.code()}")
                return Result.retry()
            }

            val messages = response.body()?.data?.messages.orEmpty()
            Log.d(TAG, "Claimed ${messages.size} outbox SMS")

            for (payload in messages) {
                if (isExpired(payload.expiresAt)) {
                    Log.w(TAG, "Skipping expired claimed SMS ${payload.smsId}")
                    continue
                }
                val recipients = payload.recipients ?: payload.receivers ?: emptyArray()
                val message = payload.message ?: payload.smsBody ?: continue
                for (recipient in recipients) {
                    SmsSendWorker.enqueue(
                        context,
                        recipient,
                        message,
                        payload.smsId,
                        payload.smsBatchId,
                        payload.simSubscriptionId,
                        payload.expiresAt
                    )
                }
            }
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Outbox claim error: ${e.message}", e)
            Result.retry()
        }
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
                    val sdf = SimpleDateFormat(pattern, Locale.US)
                    sdf.timeZone = TimeZone.getTimeZone("UTC")
                    val date = sdf.parse(expiresAt) ?: continue
                    return System.currentTimeMillis() > date.time
                } catch (_: Exception) {
                    // try next pattern
                }
            }
            false
        } catch (_: Exception) {
            false
        }
    }
}
