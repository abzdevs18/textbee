package com.vernu.sms.workers

import android.content.Context
import android.util.Log
import androidx.work.*
import com.google.gson.Gson
import com.vernu.sms.ApiManager
import com.vernu.sms.dtos.SMSDTO
import com.vernu.sms.helpers.MessageSyncNotifier
import com.vernu.sms.outbox.OutboxSync
import com.vernu.sms.outbox.SimRotationManager
import com.vernu.sms.outbox.StatusReporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Delivers one SMS status report to the API, retrying through outages. A lost
 * report leaves the server row "dispatched" and makes it re-send the SMS.
 */
class SMSStatusUpdateWorker(context: Context, workerParams: WorkerParameters) : CoroutineWorker(context, workerParams) {
    companion object {
        private const val TAG = "SMSStatusUpdateWorker"
        private const val MAX_RETRIES = 10

        const val KEY_DEVICE_ID = "device_id"
        const val KEY_API_KEY = "api_key"
        const val KEY_SMS_DTO = "sms_dto"

        /** Responses that will never succeed on retry (bad key, unknown/foreign SMS, invalid body). */
        private val PERMANENT_HTTP_CODES = setOf(400, 401, 403, 404, 409, 410, 422)

        @JvmStatic
        @JvmOverloads
        fun enqueueWork(
            context: Context,
            deviceId: String,
            apiKey: String,
            smsDTO: SMSDTO,
            replace: Boolean = false
        ) {
            val inputData = Data.Builder()
                .putString(KEY_DEVICE_ID, deviceId)
                .putString(KEY_API_KEY, apiKey)
                .putString(KEY_SMS_DTO, Gson().toJson(smsDTO))
                .build()

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val workRequest = OneTimeWorkRequest.Builder(SMSStatusUpdateWorker::class.java)
                .setConstraints(constraints)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .setInputData(inputData)
                .build()

            // One pending report per SMS, status and attempt: duplicates collapse on KEEP,
            // while resync re-reports pass replace=true to break Doze/OEM deferred-job stalls.
            val uniqueWorkName = "sms_status_${smsDTO.smsId}_${smsDTO.status}_${smsDTO.attempt ?: 0}"
            val policy = if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(uniqueWorkName, policy, workRequest)

            Log.d(TAG, "Status report queued - ID: ${smsDTO.smsId}, Status: ${smsDTO.status}, replace=$replace")
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        SmsDispatchWorker.foregroundInfo(applicationContext)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val deviceId = inputData.getString(KEY_DEVICE_ID)
        val apiKey = inputData.getString(KEY_API_KEY)
        val smsDtoJson = inputData.getString(KEY_SMS_DTO)
        if (deviceId == null || apiKey == null || smsDtoJson == null) {
            Log.e(TAG, "Missing required parameters")
            return@withContext Result.failure()
        }

        val smsDTO = try {
            Gson().fromJson(smsDtoJson, SMSDTO::class.java)
        } catch (e: Exception) {
            Log.e(TAG, "Unreadable status report: ${e.message}")
            return@withContext Result.failure()
        }

        try {
            val response = ApiManager.getApiService().updateSMSStatus(deviceId, apiKey, smsDTO).execute()
            when {
                response.isSuccessful -> {
                    Log.d(TAG, "SMS status updated - ID: ${smsDTO.smsId}, Status: ${smsDTO.status}")
                    MessageSyncNotifier.notifyChanged(applicationContext)
                    val status = smsDTO.status?.uppercase() ?: ""
                    val isAllSimsPaused = smsDTO.errorCode.equals(
                        StatusReporter.ERROR_ALL_SIMS_PAUSED, ignoreCase = true
                    )
                    val shouldRefill = (status == "SENT" || status == "DELIVERED" ||
                        status == "FAILED" || status == "UNKNOWN") &&
                        !isAllSimsPaused &&
                        !SimRotationManager.areAllSimsPaused(applicationContext)
                    if (shouldRefill) {
                        // Capacity freed on the server — pull more work right away.
                        OutboxSync.claimAndDispatch(applicationContext, "status")
                    }
                    Result.success()
                }
                response.code() in PERMANENT_HTTP_CODES -> {
                    Log.e(TAG, "Status report for ${smsDTO.smsId} rejected permanently: HTTP ${response.code()}")
                    Result.failure()
                }
                runAttemptCount + 1 >= MAX_RETRIES -> {
                    Log.e(TAG, "Giving up on status report for ${smsDTO.smsId}: HTTP ${response.code()}")
                    Result.failure()
                }
                else -> {
                    Log.w(TAG, "Status report failed: HTTP ${response.code()}; will retry")
                    Result.retry()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Status report call failed: ${e.message}")
            if (runAttemptCount + 1 >= MAX_RETRIES) Result.failure() else Result.retry()
        }
    }
}
