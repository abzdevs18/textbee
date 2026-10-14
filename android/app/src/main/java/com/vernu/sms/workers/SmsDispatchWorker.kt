package com.vernu.sms.workers

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.vernu.sms.BuildConfig
import com.vernu.sms.R
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.outbox.SmsDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import java.util.concurrent.TimeUnit

/**
 * Drains the on-phone outbox while honouring the configured delay between
 * sends. Runs as expedited work (exempt from Doze/standby deferral while quota
 * lasts) so queued SMS are not parked behind ordinary background jobs.
 */
class SmsDispatchWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    companion object {
        private const val TAG = "SmsDispatchWorker"
        const val UNIQUE_WORK = "sms_dispatch"
        private const val RUN_BUDGET_MS = 8 * 60 * 1000L
        private const val BUSY_RETRY_MS = 1000L

        /** Waits up to this long are sat out past the run budget (still well under the ~10 min job limit). */
        private const val SHORT_WAIT_MS = 30_000L

        /** The longest configurable send delay (3600 s). */
        private const val MAX_INITIAL_DELAY_MS = 60 * 60 * 1000L
        private const val PREF_RESET_VERSION = "SMS_DISPATCH_WORK_RESET_VERSION"
        private const val NOTIFICATION_ID = 7302
        private const val CHANNEL_ID = "sms_dispatch"

        /**
         * Coalesced: at most one run waiting behind the running one. Blocks
         * briefly on WorkManager state, so call it off the main thread.
         */
        @JvmStatic
        fun enqueue(context: Context, initialDelayMs: Long = 0) {
            val workManager = WorkManager.getInstance(context.applicationContext)
            val alreadyWaiting = try {
                workManager.getWorkInfosForUniqueWork(UNIQUE_WORK)
                    .get(3, TimeUnit.SECONDS)
                    .any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }
            } catch (e: Exception) {
                false
            }
            if (alreadyWaiting) return

            val builder = OneTimeWorkRequest.Builder(SmsDispatchWorker::class.java)
            if (initialDelayMs > 0) {
                // Expedited work cannot be delayed; long send delays use a normal job.
                // Never longer than the largest send delay: a parked run blocks every later kick.
                builder.setInitialDelay(initialDelayMs.coerceAtMost(MAX_INITIAL_DELAY_MS), TimeUnit.MILLISECONDS)
            } else {
                builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            workManager.enqueueUniqueWork(
                UNIQUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, builder.build()
            )
        }

        /**
         * Once per app update: cancel dispatch runs an older version scheduled
         * (2.8.21 could schedule one ~292 million years away, and a waiting run
         * makes [enqueue] skip every later kick), then start a fresh one.
         */
        @JvmStatic
        fun resetAfterUpdate(context: Context) {
            val app = context.applicationContext
            val version = BuildConfig.VERSION_CODE
            if (SharedPreferenceHelper.getSharedPreferenceInt(app, PREF_RESET_VERSION, 0) >= version) return
            SmsDispatcher.runInBackground {
                try {
                    WorkManager.getInstance(app).cancelUniqueWork(UNIQUE_WORK).result.get(5, TimeUnit.SECONDS)
                    Log.i(TAG, "Cleared dispatch runs scheduled by an older version")
                } catch (e: Exception) {
                    Log.w(TAG, "Could not clear old dispatch runs: ${e.message}")
                }
                SharedPreferenceHelper.setSharedPreferenceInt(app, PREF_RESET_VERSION, version)
                SmsDispatcher.kick(app)
            }
        }

        /** Notification for expedited work on Android 11 and older (runs as a foreground service there). */
        @JvmStatic
        fun foregroundInfo(context: Context): ForegroundInfo {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Sending SMS", NotificationManager.IMPORTANCE_LOW)
                )
            }
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("Gabay SMS")
                .setContentText("Sending queued SMS")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            return ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val deadline = SystemClock.elapsedRealtime() + RUN_BUDGET_MS
        while (!isStopped) {
            when (val outcome = SmsDispatcher.dispatchDue(applicationContext)) {
                SmsDispatcher.DispatchOutcome.Idle -> return@withContext Result.success()
                SmsDispatcher.DispatchOutcome.Busy -> delay(BUSY_RETRY_MS)
                is SmsDispatcher.DispatchOutcome.Wait -> {
                    val remaining = deadline - SystemClock.elapsedRealtime()
                    if (outcome.delayMs >= remaining && outcome.delayMs <= SHORT_WAIT_MS) {
                        // A short wait (SIM gap, confirmation poll) is cheaper to sit out than to
                        // hand to a delayed job, which Doze may postpone; continue as fresh expedited work.
                        delay(outcome.delayMs)
                        enqueue(applicationContext)
                        return@withContext Result.success()
                    }
                    if (outcome.delayMs >= remaining) {
                        // Hand the rest to a fresh run instead of overstaying the job budget.
                        Log.d(TAG, "Send delay ${outcome.delayMs}ms exceeds run budget; rescheduling")
                        enqueue(applicationContext, outcome.delayMs)
                        return@withContext Result.success()
                    }
                    delay(outcome.delayMs)
                }
            }
        }
        Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo(applicationContext)
}
