package com.vernu.sms.workers

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.vernu.sms.outbox.OutboxSync
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * WorkManager fallback for the outbox pull when it cannot run inline (no
 * network at the time, or the triggering context had no time budget left).
 */
class OutboxClaimWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    companion object {
        private const val TAG = "OutboxClaimWorker"
        private const val UNIQUE_WORK = "outbox_claim_work"
        private const val MAX_RETRIES = 5

        @JvmStatic
        fun enqueue(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = OneTimeWorkRequest.Builder(OutboxClaimWorker::class.java)
                .setConstraints(constraints)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.KEEP, request)
            Log.d(TAG, "Outbox claim work enqueued")
        }
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        when (val result = OutboxSync.claimAndDispatch(applicationContext, OutboxSync.WORKER_REASON)) {
            is OutboxSync.ClaimResult.Failed -> {
                Log.w(TAG, "Outbox claim failed (${result.reason}), attempt $runAttemptCount")
                if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
            }
            else -> Result.success()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo =
        SmsDispatchWorker.foregroundInfo(applicationContext)
}
