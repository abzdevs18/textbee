package com.vernu.sms.outbox

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

/** Life-cycle of one SMS command on this handset. */
enum class LocalState {
    /** Accepted from the server, waiting for its turn (pacing) to reach the radio. */
    QUEUED,

    /** Handed to Android's SmsManager; waiting for the SENT callback(s). */
    SUBMITTED,
    SENT,
    DELIVERED,
    FAILED,

    /** Refused because the SMS outlived the server's 2-hour max age. */
    EXPIRED,

    /**
     * Not started before its server lease ran out, so the server may already
     * have given it to another phone. Never sent from here unless re-issued.
     */
    LAPSED;

    val isTerminal: Boolean
        get() = this == SENT || this == DELIVERED || this == FAILED || this == EXPIRED

    companion object {
        fun parse(value: String?): LocalState =
            values().firstOrNull { it.name == value } ?: QUEUED
    }
}

/** A command as received from FCM or claim-outbox, normalised for storage. */
data class IncomingCommand(
    /** Unique per recipient: the server SMS id, suffixed for legacy multi-recipient payloads. */
    val localId: String,
    /** Server SMS id used for status reports. */
    val smsId: String,
    val batchId: String?,
    val recipient: String,
    val message: String,
    val simSubscriptionId: Int?,
    val attempt: Int,
    val expiresAtMs: Long?,
    val issuedAtMs: Long?,
    /** Server lease end; after it the server may hand the SMS to another phone. */
    val leaseUntilMs: Long?,
    val source: String
)

data class OutboxEntry(
    val localId: String,
    val smsId: String,
    val batchId: String?,
    val recipient: String,
    val message: String,
    val simSubscriptionId: Int?,
    val attempt: Int,
    /** Local counter bumped on every real hand-off to the radio; PendingIntents carry it. */
    val sendSeq: Int,
    val expiresAtMs: Long?,
    val issuedAtMs: Long?,
    val leaseUntilMs: Long?,
    val receivedAtMs: Long,
    val receivedElapsedMs: Long,
    val state: LocalState,
    val partsTotal: Int,
    val partsSentMask: Long,
    val partsFailedMask: Long,
    val partsDeliveredMask: Long,
    val submittedAtMs: Long?,
    val completedAtMs: Long?,
    val requestedSimId: Int?,
    val resolvedSimId: Int?,
    val errorCode: String?,
    val errorMessage: String?,
    val updatedAtMs: Long
)

sealed class AcceptResult {
    /** New command, queued for sending. */
    object Queued : AcceptResult()

    /** Deliberate server retry of a send that failed, lapsed or never confirmed: sending again. */
    object Requeued : AcceptResult()

    /** Duplicate of a command that is still waiting to be sent. */
    object AlreadyQueued : AcceptResult()

    /** Duplicate of a command already handed to the radio. */
    object InFlight : AcceptResult()

    /** Copy of a lapsed command that does not re-issue it (same attempt and lease). */
    object Stale : AcceptResult()

    /** Duplicate of a finished send: the server never got our report, so tell it again. */
    data class Rereport(val entry: OutboxEntry) : AcceptResult()
}

/** What the store must do with an incoming command (pure, unit-tested). */
enum class AcceptAction {
    INSERT,

    /** Keep the state, take the newer attempt/lease/expiry. */
    REFRESH,

    /** Back to QUEUED with fresh issue data (a new send will follow). */
    REQUEUE,

    /** Keep everything except the attempt number reports will carry. */
    BUMP_ATTEMPT,
    NONE
}

data class AcceptPlan(val action: AcceptAction, val result: AcceptResult)

/** Outcome of one SENT part callback (pure, unit-tested). */
data class SentPartPlan(
    val expected: Int,
    val sentMask: Long,
    val failedMask: Long,
    val recordError: Boolean,
    /** Non-null once every part has reported. */
    val finalState: LocalState?
)

object OutboxPolicy {
    /**
     * A command handed to the radio without any SENT callback for this long
     * may be re-sent, but only when the server explicitly retries it with a
     * newer attempt (its dispatch lease expired).
     */
    const val SUBMIT_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000L

    /**
     * Decides how a (possibly duplicate) command changes the local entry.
     * Duplicates never cause a second send unless the server deliberately
     * retries with a newer attempt (or re-issues a lapsed command).
     */
    fun decideAccept(existing: OutboxEntry?, cmd: IncomingCommand, nowMs: Long): AcceptPlan {
        if (existing == null) return AcceptPlan(AcceptAction.INSERT, AcceptResult.Queued)
        val newerAttempt = cmd.attempt > existing.attempt
        return when (existing.state) {
            LocalState.QUEUED -> AcceptPlan(
                if (newerAttempt) AcceptAction.REFRESH else AcceptAction.NONE,
                AcceptResult.AlreadyQueued
            )
            LocalState.SUBMITTED -> {
                val waitedMs = nowMs - (existing.submittedAtMs ?: nowMs)
                when {
                    newerAttempt && waitedMs >= SUBMIT_CALLBACK_TIMEOUT_MS ->
                        AcceptPlan(AcceptAction.REQUEUE, AcceptResult.Requeued)
                    // The send in progress serves the newer attempt too; report under it.
                    newerAttempt -> AcceptPlan(AcceptAction.BUMP_ATTEMPT, AcceptResult.InFlight)
                    else -> AcceptPlan(AcceptAction.NONE, AcceptResult.InFlight)
                }
            }
            LocalState.SENT, LocalState.DELIVERED -> AcceptPlan(
                if (newerAttempt) AcceptAction.BUMP_ATTEMPT else AcceptAction.NONE,
                AcceptResult.Rereport(existing)
            )
            LocalState.FAILED, LocalState.EXPIRED -> if (newerAttempt) {
                AcceptPlan(AcceptAction.REQUEUE, AcceptResult.Requeued)
            } else {
                AcceptPlan(AcceptAction.NONE, AcceptResult.Rereport(existing))
            }
            LocalState.LAPSED -> {
                val newerLease = (cmd.leaseUntilMs ?: Long.MIN_VALUE) > (existing.leaseUntilMs ?: Long.MIN_VALUE)
                if (newerAttempt || newerLease) {
                    AcceptPlan(AcceptAction.REQUEUE, AcceptResult.Requeued)
                } else {
                    AcceptPlan(AcceptAction.NONE, AcceptResult.Stale)
                }
            }
        }
    }

    /** Folds one SENT part callback into the entry; null when it must be ignored. */
    fun decideSentPart(
        entry: OutboxEntry,
        sendSeq: Int,
        partIndex: Int,
        partCount: Int,
        ok: Boolean
    ): SentPartPlan? {
        if (entry.sendSeq != sendSeq || entry.state != LocalState.SUBMITTED) return null
        val expected = PartMath.expected(entry.partsTotal, partCount)
        val bit = PartMath.bit(partIndex)
        val sentMask = if (ok) entry.partsSentMask or bit else entry.partsSentMask
        val failedMask = if (ok) entry.partsFailedMask else entry.partsFailedMask or bit
        val complete = PartMath.isComplete(sentMask or failedMask, expected)
        val finalState = when {
            !complete -> null
            failedMask != 0L -> LocalState.FAILED
            // A delivery report that raced ahead of the last SENT callback.
            PartMath.isComplete(entry.partsDeliveredMask, expected) -> LocalState.DELIVERED
            else -> LocalState.SENT
        }
        return SentPartPlan(
            expected = expected,
            sentMask = sentMask,
            failedMask = failedMask,
            recordError = !ok && entry.errorCode == null,
            finalState = finalState
        )
    }

    /** Safety margin: never *start* a send this close to the end of the server lease. */
    const val LEASE_START_MARGIN_MS = 15_000L

    fun isLeaseLapsed(entry: OutboxEntry, nowWallMs: Long, nowElapsedMs: Long): Boolean {
        val leaseUntil = entry.leaseUntilMs ?: return false
        val serverNow = ExpiryClock.estimateServerNow(
            entry.issuedAtMs, entry.receivedAtMs, entry.receivedElapsedMs, nowWallMs, nowElapsedMs
        )
        return serverNow > leaseUntil - LEASE_START_MARGIN_MS
    }
}

sealed class PartOutcome {
    /** Stale callback (older send) or unknown command. */
    object Ignored : PartOutcome()

    /** More parts are still outstanding. */
    object Pending : PartOutcome()

    /** All parts reported: the entry reached a final state. */
    data class Completed(val entry: OutboxEntry) : PartOutcome()
}

/** Bit bookkeeping for multipart messages (pure, unit-tested). */
object PartMath {
    const val MAX_TRACKED_PARTS = 63

    fun bit(partIndex: Int): Long {
        val index = partIndex.coerceIn(0, MAX_TRACKED_PARTS - 1)
        return 1L shl index
    }

    fun expected(partsTotal: Int, reportedCount: Int): Int =
        maxOf(1, partsTotal, reportedCount).coerceAtMost(MAX_TRACKED_PARTS)

    fun isComplete(mask: Long, expected: Int): Boolean =
        java.lang.Long.bitCount(mask) >= expected
}

/**
 * Judges the server's 2-hour expiry without trusting the phone's wall clock.
 * Commands carry `issuedAt` (server time at hand-off); elapsed time since
 * receipt is measured with the monotonic clock while the phone stays up.
 */
object ExpiryClock {
    private const val SAME_BOOT_TOLERANCE_MS = 5 * 60 * 1000L

    fun estimateServerNow(
        issuedAtMs: Long?,
        receivedAtMs: Long,
        receivedElapsedMs: Long,
        nowWallMs: Long,
        nowElapsedMs: Long
    ): Long {
        if (issuedAtMs == null) return nowWallMs
        val receivedBootWall = receivedAtMs - receivedElapsedMs
        val currentBootWall = nowWallMs - nowElapsedMs
        val sameBoot = nowElapsedMs >= receivedElapsedMs &&
            abs(currentBootWall - receivedBootWall) < SAME_BOOT_TOLERANCE_MS
        return if (sameBoot) {
            issuedAtMs + (nowElapsedMs - receivedElapsedMs)
        } else {
            // Rebooted since receipt: fall back to the wall clock corrected by
            // the skew observed when the command arrived.
            nowWallMs - (receivedAtMs - issuedAtMs)
        }
    }

    fun isExpired(entry: OutboxEntry, nowWallMs: Long, nowElapsedMs: Long): Boolean {
        val expiresAt = entry.expiresAtMs ?: return false
        val serverNow = estimateServerNow(
            entry.issuedAtMs, entry.receivedAtMs, entry.receivedElapsedMs, nowWallMs, nowElapsedMs
        )
        return serverNow > expiresAt
    }
}

/** Parses the ISO-8601 instants the API sends (`Date.toISOString()`), or epoch millis. */
object ServerTime {
    private val PATTERNS = arrayOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSSX",
        "yyyy-MM-dd'T'HH:mm:ssX"
    )

    fun parse(value: String?): Long? {
        val raw = value?.trim()
        if (raw.isNullOrEmpty()) return null
        raw.toLongOrNull()?.let { return it }
        for (pattern in PATTERNS) {
            try {
                val format = SimpleDateFormat(pattern, Locale.US)
                format.timeZone = TimeZone.getTimeZone("UTC")
                format.isLenient = false
                val parsed = format.parse(raw) ?: continue
                return parsed.time
            } catch (_: Exception) {
                // 'X' is unsupported before API 24; try the next pattern.
            }
        }
        return null
    }
}
