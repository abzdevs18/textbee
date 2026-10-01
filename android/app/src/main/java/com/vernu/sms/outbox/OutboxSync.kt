package com.vernu.sms.outbox

import android.content.Context
import android.util.Log
import com.vernu.sms.ApiManager
import com.vernu.sms.AppConstants
import com.vernu.sms.dtos.ClaimOutboxRequest
import com.vernu.sms.helpers.GatewayConfigSync
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.workers.OutboxClaimWorker
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pull path to the server outbox (claim-outbox). It does not depend on FCM:
 * heartbeats, the poll alarm, work_available pushes and status reports all
 * funnel through here, and every pull also asks for work the server thinks
 * this phone already holds (`resync`), so a lost push heals within one pull.
 */
object OutboxSync {
    private const val TAG = "OutboxSync"
    private const val CLAIM_LIMIT = 10

    /**
     * Resync re-delivers work the server thinks this phone holds. Right after an
     * install/upgrade the outbox has no memory of what the previous app version
     * already handed to the radio, so wait one dispatch lease (their reports
     * land, or the server re-issues them) before asking for it.
     */
    private const val PREF_RESYNC_AFTER_MS = "OUTBOX_RESYNC_AFTER_MS"
    private const val RESYNC_WARMUP_MS = 10 * 60 * 1000L

    private val running = AtomicBoolean(false)
    private val requested = AtomicBoolean(false)
    private val network: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "gabay-sms-claim").apply { isDaemon = true }
    }

    sealed class ClaimResult {
        data class Ok(val received: Int) : ClaimResult()

        /** Not registered or gateway disabled. */
        object Skipped : ClaimResult()

        /** Another claim was already running and will cover this request. */
        object Coalesced : ClaimResult()
        data class Failed(val reason: String) : ClaimResult()
    }

    /**
     * Blocking: pulls work from the server and hands due SMS to the radio.
     * Concurrent callers coalesce into the running claim. Never call on the
     * main thread.
     */
    @JvmStatic
    fun claimAndDispatch(context: Context, reason: String): ClaimResult {
        val app = context.applicationContext
        requested.set(true)
        var last: ClaimResult = ClaimResult.Coalesced
        while (requested.get() && running.compareAndSet(false, true)) {
            try {
                while (requested.getAndSet(false)) {
                    last = claimOnce(app, reason)
                    if (last is ClaimResult.Failed) break
                }
            } finally {
                running.set(false)
            }
            if (last is ClaimResult.Failed) break
        }
        if (last is ClaimResult.Failed && reason != WORKER_REASON) {
            // Callers that coalesced into this run were told "covered"; make sure
            // the pull still happens once the network is back.
            OutboxClaimWorker.enqueue(app)
        }
        return last
    }

    /** Reason used by [OutboxClaimWorker], which retries through WorkManager itself. */
    const val WORKER_REASON = "worker"

    /** Fire-and-forget claim; failures fall back to a WorkManager job. */
    @JvmStatic
    fun requestClaim(context: Context, reason: String) {
        val app = context.applicationContext
        network.execute {
            try {
                claimAndDispatch(app, reason)
            } catch (e: Exception) {
                Log.e(TAG, "Claim ($reason) crashed: ${e.message}", e)
                OutboxClaimWorker.enqueue(app)
            }
        }
    }

    private fun resyncAllowed(context: Context, now: Long): Boolean {
        val after = SharedPreferenceHelper.getSharedPreferenceString(
            context, PREF_RESYNC_AFTER_MS, null
        )?.toLongOrNull()
        if (after == null) {
            SharedPreferenceHelper.setSharedPreferenceString(
                context, PREF_RESYNC_AFTER_MS, (now + RESYNC_WARMUP_MS).toString()
            )
            return false
        }
        return now >= after
    }

    /** Runs [block] on the claim thread (used by receivers that hold goAsync()). */
    @JvmStatic
    fun runOnNetworkThread(block: () -> Unit) {
        network.execute {
            try {
                block()
            } catch (e: Exception) {
                Log.e(TAG, "Network task failed: ${e.message}", e)
            }
        }
    }

    private fun claimOnce(context: Context, reason: String): ClaimResult {
        val deviceId = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_DEVICE_ID_KEY, ""
        ) ?: ""
        val apiKey = SharedPreferenceHelper.getSharedPreferenceString(
            context, AppConstants.SHARED_PREFS_API_KEY_KEY, ""
        ) ?: ""
        if (deviceId.isBlank() || apiKey.isBlank()) return ClaimResult.Skipped
        if (!GatewayConfigSync.isGatewayEnabled(context)) return ClaimResult.Skipped

        return try {
            val request = ClaimOutboxRequest().apply {
                limit = CLAIM_LIMIT
                resync = resyncAllowed(context, System.currentTimeMillis())
            }
            val response = ApiManager.getApiService()
                .claimOutbox(deviceId, apiKey, request)
                .execute()
            if (!response.isSuccessful) {
                Log.w(TAG, "claim-outbox ($reason) failed: HTTP ${response.code()}")
                return ClaimResult.Failed("HTTP ${response.code()}")
            }

            val data = response.body()?.data
            val messages = data?.messages.orEmpty()
            for (payload in messages) {
                val target = payload.targetDeviceId ?: payload.deviceId
                if (!target.isNullOrBlank() && target != deviceId) {
                    Log.w(TAG, "Skipping claimed SMS ${payload.smsId} addressed to $target")
                    continue
                }
                SmsDispatcher.accept(context, payload, "claim:$reason")
            }
            if (messages.isNotEmpty()) {
                Log.d(
                    TAG,
                    "claim-outbox ($reason): ${data?.claimed ?: 0} new, ${data?.redelivered ?: 0} resynced"
                )
            }
            // Send immediately in this context; paced remainder goes to the worker.
            SmsDispatcher.pump(context)
            ClaimResult.Ok(messages.size)
        } catch (e: Exception) {
            Log.w(TAG, "claim-outbox ($reason) error: ${e.message}")
            ClaimResult.Failed(e.message ?: e.javaClass.simpleName)
        }
    }
}
