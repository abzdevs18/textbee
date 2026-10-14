package com.vernu.sms.outbox

import android.Manifest
import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.vernu.sms.AppConstants
import com.vernu.sms.TextBeeUtils
import com.vernu.sms.helpers.GatewayConfigSync
import com.vernu.sms.helpers.MessageSyncNotifier
import com.vernu.sms.helpers.SMSHelper
import com.vernu.sms.helpers.SharedPreferenceHelper
import com.vernu.sms.models.SMSPayload
import com.vernu.sms.workers.SmsDispatchWorker
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.locks.ReentrantLock

/**
 * Moves commands from the on-phone outbox to Android's SMS stack.
 *
 * Commands are persisted first ([accept]), then the due ones are handed to the
 * radio immediately in whatever context received them (FCM handler, claim
 * pull, worker). Pacing between sends is kept by [SmsDispatchWorker], which
 * runs as expedited work so Doze/standby cannot park queued SMS for hours.
 */
object SmsDispatcher {
    private const val TAG = "SmsDispatcher"
    private const val PREF_LAST_SUBMIT_AT_MS = "OUTBOX_LAST_SUBMIT_AT_MS"
    private const val PRUNE_INTERVAL_MS = 60 * 60 * 1000L

    private val dispatchLock = ReentrantLock()
    private val background: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "gabay-sms-dispatch").apply { isDaemon = true }
    }

    @Volatile
    private var lastPruneAtMs = 0L

    sealed class DispatchOutcome {
        /** Nothing is waiting to be sent. */
        object Idle : DispatchOutcome()

        /** Another thread is dispatching right now. */
        object Busy : DispatchOutcome()

        /** The next SMS is due later (send delay, SIM gap, or waiting for a network confirmation). */
        data class Wait(val delayMs: Long) : DispatchOutcome()
    }

    data class AcceptSummary(val queued: Int, val duplicates: Int, val rereported: Int)

    /** Runs [block] on the dispatcher's background thread. */
    @JvmStatic
    fun runInBackground(block: () -> Unit) {
        background.execute {
            try {
                block()
            } catch (e: Exception) {
                Log.e(TAG, "Background outbox task failed: ${e.message}", e)
            }
        }
    }

    /** Persists a server command (one entry per recipient). Safe to call repeatedly. */
    @JvmStatic
    fun accept(context: Context, payload: SMSPayload, source: String): AcceptSummary {
        val app = context.applicationContext
        val smsId = payload.smsId?.trim()
        val message = payload.message ?: payload.smsBody
        val recipients = (payload.recipients ?: payload.receivers)
            ?.mapNotNull { it?.replace(Regex("\\s+"), "")?.takeIf { value -> value.isNotEmpty() } }
            .orEmpty()

        if (smsId.isNullOrEmpty()) {
            Log.e(TAG, "Ignoring command without smsId from $source")
            return AcceptSummary(0, 0, 0)
        }
        if (message == null || recipients.isEmpty()) {
            Log.e(TAG, "Refusing malformed command $smsId from $source")
            StatusReporter.reportRefusal(
                app, smsId, payload.smsBatchId, payload.attempt,
                if (recipients.isEmpty()) StatusReporter.ERROR_INVALID_RECIPIENT else "INVALID_PAYLOAD",
                "Command reached the phone without a recipient or message body"
            )
            return AcceptSummary(0, 0, 0)
        }

        val store = OutboxStore.get(app)
        val now = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        val attempt = payload.attempt?.takeIf { it > 0 } ?: 1
        val expiresAt = ServerTime.parse(payload.expiresAt)
        val issuedAt = ServerTime.parse(payload.issuedAt)
        // A lease is only meaningful against server time, i.e. with issuedAt.
        val leaseUntil = if (issuedAt != null) ServerTime.parse(payload.leaseUntil) else null
        val requestedSim = payload.simSubscriptionId?.takeIf { it >= 0 }

        var queued = 0
        var duplicates = 0
        var rereported = 0
        recipients.forEachIndexed { index, recipient ->
            // Current servers send one recipient per SMS id; legacy payloads
            // with several recipients keep reporting under the same id.
            val localId = if (index == 0) smsId else "$smsId#$index"
            val command = IncomingCommand(
                localId = localId,
                smsId = smsId,
                batchId = payload.smsBatchId,
                recipient = recipient,
                message = message,
                simSubscriptionId = requestedSim,
                attempt = attempt,
                expiresAtMs = expiresAt,
                issuedAtMs = issuedAt,
                leaseUntilMs = leaseUntil,
                source = source
            )
            when (val result = store.accept(command, now, elapsed)) {
                AcceptResult.Queued, AcceptResult.Requeued -> queued++
                AcceptResult.AlreadyQueued, AcceptResult.InFlight, AcceptResult.Stale -> duplicates++
                is AcceptResult.Rereport -> {
                    rereported++
                    StatusReporter.reportFinal(app, result.entry)
                }
            }
        }

        Log.d(
            TAG,
            "Accepted SMS $smsId (attempt $attempt) from $source: queued=$queued duplicates=$duplicates rereported=$rereported"
        )
        maybePrune(store, now)
        MessageSyncNotifier.notifyChanged(app)
        return AcceptSummary(queued, duplicates, rereported)
    }

    /**
     * Sends every SMS that is due now. Never sleeps: when the send delay says
     * "not yet" it returns [DispatchOutcome.Wait]. Must not run on the main thread.
     */
    @JvmStatic
    fun dispatchDue(context: Context): DispatchOutcome {
        val app = context.applicationContext
        if (!dispatchLock.tryLock()) return DispatchOutcome.Busy
        try {
            val store = OutboxStore.get(app)
            while (true) {
                val entry = store.nextQueued() ?: return DispatchOutcome.Idle
                val now = System.currentTimeMillis()
                val elapsed = SystemClock.elapsedRealtime()

                // Past its lease the server may already have given it to another
                // phone: never start it here; a re-issue (newer attempt) requeues it.
                if (OutboxPolicy.isLeaseLapsed(entry, now, elapsed)) {
                    Log.w(TAG, "Lease ran out before SMS ${entry.localId} could be sent; waiting for re-issue")
                    store.markLapsed(entry.localId, now)
                    MessageSyncNotifier.notifyChanged(app)
                    continue
                }

                val refusal = refusalFor(app, entry, now, elapsed)
                if (refusal != null) {
                    val (state, code, message) = refusal
                    store.finish(entry.localId, state, code, message, now)?.let {
                        StatusReporter.reportFinal(app, it)
                    }
                    MessageSyncNotifier.notifyChanged(app)
                    continue
                }

                if (!SimRotationManager.isEnabled(app)) {
                    val waitMs = pacingWaitMs(app, now)
                    if (waitMs > 0) return DispatchOutcome.Wait(waitMs)
                    submit(app, store, entry, now)
                    continue
                }

                val decision = SimRotationManager.decide(app, now) { localId, sendSeq ->
                    SimRotationPolicy.timeoutOutcome(store.get(localId), sendSeq)
                }
                when (decision) {
                    is SimDecision.Wait -> return DispatchOutcome.Wait(decision.delayMs)
                    is SimDecision.Send -> submitOnSim(app, store, entry, decision.sim, now)
                    SimDecision.NoUsableSim -> {
                        // Retryable for the server: it moves the SMS to another phone.
                        store.finish(
                            entry.localId, LocalState.FAILED, StatusReporter.ERROR_ALL_SIMS_PAUSED,
                            "Every SIM on this phone is paused after ${SimRotationPolicy.FAILURE_LIMIT} failed SMS in a row. " +
                                "Reload the SIMs, then restart the Gabay SMS app.",
                            now
                        )?.let { StatusReporter.reportFinal(app, it) }
                        MessageSyncNotifier.notifyChanged(app)
                    }
                    is SimDecision.TimedOut -> Unit // resolved inside decide()
                }
            }
        } finally {
            dispatchLock.unlock()
        }
    }

    /** Sends what is due now and makes sure the paced remainder gets a worker. */
    @JvmStatic
    fun pump(context: Context) {
        val outcome = try {
            dispatchDue(context)
        } catch (e: Exception) {
            Log.e(TAG, "Immediate dispatch failed: ${e.message}", e)
            DispatchOutcome.Busy
        }
        if (outcome !is DispatchOutcome.Idle) kick(context)
    }

    /** Asynchronous [pump] for callers on the main thread. */
    @JvmStatic
    fun pumpAsync(context: Context) {
        val app = context.applicationContext
        runInBackground { pump(app) }
    }

    /** Ensures a dispatch worker will run if anything is queued. Cheap; call freely. */
    @JvmStatic
    fun kick(context: Context) {
        val app = context.applicationContext
        runInBackground {
            if (OutboxStore.get(app).countQueued() > 0) {
                SmsDispatchWorker.enqueue(app)
            }
        }
    }

    private fun refusalFor(
        context: Context,
        entry: OutboxEntry,
        now: Long,
        elapsed: Long
    ): Triple<LocalState, String, String>? {
        if (!GatewayConfigSync.isGatewayEnabled(context)) {
            return Triple(
                LocalState.FAILED, StatusReporter.ERROR_GATEWAY_DISABLED,
                "Gateway is disabled on this device; command refused"
            )
        }
        if (ExpiryClock.isExpired(entry, now, elapsed)) {
            return Triple(
                LocalState.EXPIRED, StatusReporter.ERROR_EXPIRED,
                "SMS exceeded max pending age (2 hours); device refused send"
            )
        }
        if (!TextBeeUtils.isPermissionGranted(context, Manifest.permission.SEND_SMS)) {
            return Triple(
                LocalState.FAILED, StatusReporter.ERROR_PERMISSION_DENIED,
                "SMS permission not granted"
            )
        }
        if (entry.recipient.isBlank()) {
            return Triple(
                LocalState.FAILED, StatusReporter.ERROR_INVALID_RECIPIENT,
                "Recipient number is empty"
            )
        }
        return null
    }

    /** Rotation off: the server's SIM, else the preferred SIM, else the phone default. */
    private fun submit(context: Context, store: OutboxStore, entry: OutboxEntry, now: Long) {
        val sim = resolveRequestedSim(context, entry.simSubscriptionId)

        val prepared = try {
            val manager = SMSHelper.smsManagerFor(context, sim)
            manager to SMSHelper.divide(manager, entry.message)
        } catch (e: Exception) {
            failSubmission(context, store, entry, e, now)
            return
        }
        val (manager, parts) = prepared

        val sendSeq = store.markSubmitted(entry.localId, parts.size, sim, sim, now)
            ?: return // claimed by another path meanwhile
        markSubmittedNow(context, now)

        try {
            SMSHelper.submit(context, manager, entry, parts, sendSeq, sim, sim)
            Log.d(TAG, "Handed SMS ${entry.localId} to the radio (${parts.size} part(s), attempt ${entry.attempt})")
        } catch (e: Exception) {
            failSubmission(context, store, entry, e, now)
            return
        }
        MessageSyncNotifier.notifyChanged(context)
    }

    /** Rotation on: send on the SIM the rotation picked; the server's SIM choice is not used. */
    private fun submitOnSim(context: Context, store: OutboxStore, entry: OutboxEntry, sim: Int, now: Long) {
        val subscriptionId = SimRotationManager.subscriptionIdFor(sim)
        val requestedSim = entry.simSubscriptionId?.takeIf { it >= 0 }
        if (requestedSim != null && requestedSim != subscriptionId) {
            Log.d(TAG, "SIM rotation sends ${entry.localId} on SIM $sim instead of requested SIM $requestedSim")
        }

        val prepared = try {
            val manager = SMSHelper.smsManagerFor(context, subscriptionId)
            manager to SMSHelper.divide(manager, entry.message)
        } catch (e: Exception) {
            val code = failSubmission(context, store, entry, e, now)
            SimRotationManager.onFailedBeforeStart(
                context, sim, SimRotationPolicy.outcomeOfError(code), System.currentTimeMillis()
            )
            return
        }
        val (manager, parts) = prepared

        val sendSeq = store.markSubmitted(entry.localId, parts.size, requestedSim, subscriptionId, now)
            ?: return // claimed by another path meanwhile
        SimRotationManager.onStarted(context, entry.localId, sendSeq, sim, now)

        try {
            SMSHelper.submit(context, manager, entry, parts, sendSeq, requestedSim, subscriptionId)
            Log.d(TAG, "Handed SMS ${entry.localId} to the radio on SIM $sim (${parts.size} part(s), attempt ${entry.attempt})")
        } catch (e: Exception) {
            val code = failSubmission(context, store, entry, e, now)
            SimRotationManager.onFinished(
                context, entry.localId, sendSeq, SimRotationPolicy.outcomeOfError(code),
                System.currentTimeMillis()
            )
            return
        }
        MessageSyncNotifier.notifyChanged(context)
    }

    /** @return the error code reported for the failure. */
    private fun failSubmission(
        context: Context,
        store: OutboxStore,
        entry: OutboxEntry,
        error: Exception,
        now: Long
    ): String {
        Log.e(TAG, "SmsManager rejected SMS ${entry.localId}: ${error.message}", error)
        val (code, message) = SMSHelper.classifySendException(error)
        store.finish(entry.localId, LocalState.FAILED, code, message, now)?.let {
            StatusReporter.reportFinal(context, it)
        }
        MessageSyncNotifier.notifyChanged(context)
        return code
    }

    private fun resolveRequestedSim(context: Context, backendSimId: Int?): Int? {
        if (backendSimId != null && backendSimId >= 0 &&
            TextBeeUtils.isValidSubscriptionId(context, backendSimId)
        ) {
            return backendSimId
        }
        val preferredSim = SharedPreferenceHelper.getSharedPreferenceInt(
            context, AppConstants.SHARED_PREFS_PREFERRED_SIM_KEY, -1
        )
        if (preferredSim != -1 && TextBeeUtils.isValidSubscriptionId(context, preferredSim)) {
            return preferredSim
        }
        return null
    }

    private fun sendDelayMs(context: Context): Long {
        val seconds = SharedPreferenceHelper.getSharedPreferenceInt(
            context, AppConstants.SHARED_PREFS_SMS_SEND_DELAY_SECONDS_KEY,
            AppConstants.DEFAULT_SMS_SEND_DELAY_SECONDS
        ).coerceIn(0, 3600)
        return seconds * 1000L
    }

    private fun pacingWaitMs(context: Context, now: Long): Long {
        val delayMs = sendDelayMs(context)
        if (delayMs <= 0) return 0
        val last = SharedPreferenceHelper.getSharedPreferenceString(
            context, PREF_LAST_SUBMIT_AT_MS, null
        )?.toLongOrNull() ?: return 0
        // Clamp so a wall-clock jump can never park the queue for longer than one delay.
        return (last + delayMs - now).coerceIn(0, delayMs)
    }

    private fun markSubmittedNow(context: Context, now: Long) {
        SharedPreferenceHelper.setSharedPreferenceString(
            context, PREF_LAST_SUBMIT_AT_MS, now.toString()
        )
    }

    private fun maybePrune(store: OutboxStore, now: Long) {
        if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return
        lastPruneAtMs = now
        try {
            store.prune(now)
        } catch (e: Exception) {
            Log.w(TAG, "Outbox prune failed: ${e.message}")
        }
    }
}
