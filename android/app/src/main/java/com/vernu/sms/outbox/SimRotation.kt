package com.vernu.sms.outbox

import android.app.Activity
import android.telephony.SmsManager

/** What one finished send says about the health of the SIM that carried it. */
enum class SimOutcome {
    /** The network accepted the SMS: the SIM works. */
    SUCCESS,

    /** Refused at the sending step for a SIM/network reason (no load, no signal, no confirmation). */
    SIM_FAILURE,

    /** Failed because of the recipient or the message itself; says nothing about the SIM. */
    NEUTRAL
}

/** A send handed to the radio that has not been confirmed yet. */
data class SimInFlight(
    /** `localId#sendSeq`: unique per real hand-off, matches the PendingIntent data. */
    val key: String,
    val sim: Int,
    val submittedAtMs: Long
)

/** Timeout resolution category for one in-flight send. */
enum class InFlightTimeoutKind {
    /** Still within the confirmation/grace window. */
    NONE,

    /** Outbox row is already gone, terminal, or superseded by a newer sendSeq. */
    ALREADY_FINISHED,

    /** Multipart SMS with >=1 confirmed part and 0 failed parts past partial-confirm grace. */
    PARTIAL_CONFIRMED,

    /** Multipart SMS with >=1 failed part that never finished reporting remaining parts. */
    PARTIAL_FAILED,

    /** Zero parts confirmed within CONFIRM_TIMEOUT_MS: ambiguous radio outcome. */
    UNCONFIRMED
}

/** One in-flight send that timed out (or finished out of band) and needs outbox reconciliation. */
data class ResolvedTimeout(
    val flight: SimInFlight,
    val kind: InFlightTimeoutKind,
    val localId: String,
    val sendSeq: Int
)

/** Pacing memory of the rotation; survives app restarts. */
data class SimRotationState(
    /** SIM the last send was started on; the next send prefers the one after it. */
    val lastSim: Int? = null,
    /** When the last send was handed to the radio on any SIM (paces [SimRotationPolicy.DEVICE_GAP_MS]). */
    val lastSubmitAnyMs: Long? = null,
    /** When the last send was handed to the radio on each SIM (paces [SimRotationPolicy.SIM_GAP_MS]). */
    val lastSubmitBySim: Map<Int, Long> = emptyMap(),
    /** At most one unconfirmed send per SIM, so one slow SIM never blocks the other SIM. */
    val inFlightBySim: Map<Int, SimInFlight> = emptyMap()
)

sealed class SimDecision {
    data class Send(val sim: Int) : SimDecision()
    data class Wait(val delayMs: Long) : SimDecision()

    /** An in-flight send hit [SimRotationPolicy.CONFIRM_TIMEOUT_MS]; reconcile it, then decide again. */
    data class TimedOut(val inFlight: SimInFlight) : SimDecision()

    /** Every SIM is paused (or none is present). */
    object NoUsableSim : SimDecision()
}

/**
 * Alternating dual-SIM sending (pure, unit-tested):
 * - SIM 1 → SIM 2 → SIM 1 …, spaced by [DEVICE_GAP_MS] (10s) from the last submission
 *   across the phone and [SIM_GAP_MS] (20s) from the last submission on the same SIM
 *   (so a single usable SIM sends every 20s, and dual-SIM sends every 10s),
 * - at most one unconfirmed send in flight per SIM (never stacks two unconfirmed sends
 *   on the same SIM, while a slow/hung SIM never blocks the other healthy SIM),
 * - clearing a finished or timed-out in-flight send does NOT re-stamp submit gaps
 *   (eliminating the old +10s/+20s double penalty after a 60s timeout),
 * - a SIM that fails [FAILURE_LIMIT] sends in a row is paused until the app restarts.
 */
object SimRotationPolicy {
    const val DEVICE_GAP_MS = 10_000L
    const val SIM_GAP_MS = 20_000L
    const val CONFIRM_TIMEOUT_MS = 60_000L

    /**
     * Grace window after the last confirmed part of a multipart SMS before finalizing as SENT.
     * Prevents perpetual 60s stalls on phones whose RIL drops one segment's SENT callback.
     */
    const val PARTIAL_CONFIRM_GRACE_MS = 20_000L
    const val FAILURE_LIMIT = 5

    /** Stand-in id when Android does not list SIMs: the phone's default SMS SIM. */
    const val DEFAULT_SIM = -1

    /** While a send is unconfirmed and blocking the next turn, poll this often. */
    const val CONFIRM_POLL_MS = 1_000L

    /** Failure codes caused by the recipient or the message, not by the SIM. */
    private val NEUTRAL_RESULT_CODES = setOf(
        SmsManager.RESULT_ERROR_NULL_PDU,
        SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE,
        SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED,
        SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED,
        SmsManager.RESULT_INVALID_ARGUMENTS,
        SmsManager.RESULT_INVALID_SMS_FORMAT,
        SmsManager.RESULT_RIL_INVALID_ARGUMENTS,
        SmsManager.RESULT_RIL_INVALID_SMS_FORMAT
    ).map { it.toString() }.toSet()

    private val NEUTRAL_LOCAL_CODES = setOf(
        StatusReporter.ERROR_INVALID_RECIPIENT,
        StatusReporter.ERROR_PERMISSION_DENIED
    )

    /** Splits `localId#sendSeq` into `(localId, sendSeq)`, or null if malformed. */
    fun parseFlightKey(key: String): Pair<String, Int>? {
        val sep = key.lastIndexOf('#')
        if (sep <= 0) return null
        val seq = key.substring(sep + 1).toIntOrNull() ?: return null
        return key.substring(0, sep) to seq
    }

    /** Classifies the final state of an outbox entry. */
    fun outcomeOf(state: LocalState, errorCode: String?): SimOutcome = when (state) {
        LocalState.SENT, LocalState.DELIVERED -> SimOutcome.SUCCESS
        LocalState.FAILED -> outcomeOfError(errorCode)
        LocalState.UNKNOWN -> SimOutcome.SIM_FAILURE
        else -> SimOutcome.NEUTRAL
    }

    /** Classifies a SENT result code or a local error code. */
    fun outcomeOfError(errorCode: String?): SimOutcome {
        val code = errorCode?.trim().orEmpty()
        return when {
            code == Activity.RESULT_OK.toString() -> SimOutcome.SUCCESS
            code in NEUTRAL_RESULT_CODES || code in NEUTRAL_LOCAL_CODES -> SimOutcome.NEUTRAL
            else -> SimOutcome.SIM_FAILURE
        }
    }

    /**
     * What a send that got no complete confirmation within [CONFIRM_TIMEOUT_MS]
     * says about its SIM. [entry] is the outbox row as it is now.
     */
    fun timeoutOutcome(entry: OutboxEntry?, sendSeq: Int): SimOutcome {
        // Gone, re-sent since, or already answered: nothing to blame on the SIM.
        if (entry == null || entry.sendSeq != sendSeq || entry.state != LocalState.SUBMITTED) {
            return SimOutcome.NEUTRAL
        }
        // Some phones confirm only part of a long SMS; a confirmed part proves the SIM works.
        return when {
            entry.partsFailedMask != 0L -> outcomeOfError(entry.errorCode)
            entry.partsSentMask != 0L -> SimOutcome.NEUTRAL
            else -> SimOutcome.SIM_FAILURE
        }
    }

    /**
     * Evaluates whether [flight] has timed out (or passed the multipart partial-confirmation
     * grace window) based on its current [entry]. Returns `(kind, remainingMs)` where
     * `remainingMs == 0L` whenever `kind != NONE`.
     */
    fun evaluateInFlightTimeout(
        flight: SimInFlight,
        entry: OutboxEntry?,
        nowMs: Long
    ): Pair<InFlightTimeoutKind, Long> {
        val parsed = parseFlightKey(flight.key)
            ?: return InFlightTimeoutKind.UNCONFIRMED to 0L
        val sendSeq = parsed.second
        if (entry == null || entry.sendSeq != sendSeq || entry.state != LocalState.SUBMITTED) {
            return InFlightTimeoutKind.ALREADY_FINISHED to 0L
        }

        val waited = nowMs - flight.submittedAtMs
        // Clock jumped backwards: resolve immediately rather than parking indefinitely.
        if (waited < 0) {
            return when {
                entry.partsFailedMask != 0L -> InFlightTimeoutKind.PARTIAL_FAILED to 0L
                entry.partsSentMask != 0L -> InFlightTimeoutKind.PARTIAL_CONFIRMED to 0L
                else -> InFlightTimeoutKind.UNCONFIRMED to 0L
            }
        }

        if (entry.partsSentMask != 0L && entry.partsFailedMask == 0L) {
            val anchor = maxOf(flight.submittedAtMs, entry.updatedAtMs)
            val graceDeadline = minOf(
                flight.submittedAtMs + CONFIRM_TIMEOUT_MS,
                anchor + PARTIAL_CONFIRM_GRACE_MS
            )
            if (nowMs < anchor || nowMs >= graceDeadline) {
                return InFlightTimeoutKind.PARTIAL_CONFIRMED to 0L
            }
            return InFlightTimeoutKind.NONE to (graceDeadline - nowMs)
        }

        if (waited >= CONFIRM_TIMEOUT_MS) {
            return if (entry.partsFailedMask != 0L) {
                InFlightTimeoutKind.PARTIAL_FAILED to 0L
            } else {
                InFlightTimeoutKind.UNCONFIRMED to 0L
            }
        }

        return InFlightTimeoutKind.NONE to (CONFIRM_TIMEOUT_MS - waited)
    }

    /** The SIM after [lastSim] in [usable] (slot order), wrapping around. */
    fun nextSim(usable: List<Int>, lastSim: Int?): Int? {
        if (usable.isEmpty()) return null
        val index = usable.indexOf(lastSim)
        return if (index < 0) usable[0] else usable[(index + 1) % usable.size]
    }

    /** [usable] rotated so the SIM right after [lastSim] comes first. */
    fun orderedFromLast(usable: List<Int>, lastSim: Int?): List<Int> {
        if (usable.isEmpty()) return emptyList()
        val index = usable.indexOf(lastSim)
        if (index < 0) return usable
        return List(usable.size) { offset -> usable[(index + 1 + offset) % usable.size] }
    }

    /** Earliest time [sim] may send; [nowMs] when nothing has been submitted yet. */
    fun readyAt(state: SimRotationState, sim: Int, nowMs: Long): Long {
        val afterDevice = state.lastSubmitAnyMs?.plus(DEVICE_GAP_MS)
        val afterSim = state.lastSubmitBySim[sim]?.plus(SIM_GAP_MS)
        val ready = listOfNotNull(afterDevice, afterSim).maxOrNull() ?: return nowMs
        // Further out than one SIM gap means the clock moved backwards: never park the queue on it.
        return if (ready > nowMs + SIM_GAP_MS) nowMs else ready
    }

    fun decide(state: SimRotationState, usable: List<Int>, nowMs: Long): SimDecision {
        // Resolve any timed-out in-flight send first (earliest submitted first).
        val expired = state.inFlightBySim.values
            .filter { flight -> (nowMs - flight.submittedAtMs) !in 0 until CONFIRM_TIMEOUT_MS }
            .minByOrNull { it.submittedAtMs }
        if (expired != null) return SimDecision.TimedOut(expired)

        if (usable.isEmpty()) return SimDecision.NoUsableSim

        val ordered = orderedFromLast(usable, state.lastSim)
        val freeSims = ordered.filter { it !in state.inFlightBySim }

        val earliestTimeoutRemaining = state.inFlightBySim.values
            .minOfOrNull { (CONFIRM_TIMEOUT_MS - (nowMs - it.submittedAtMs)).coerceAtLeast(1L) }

        if (freeSims.isNotEmpty()) {
            // Pick the free SIM with the shortest wait (ties preserve round-robin order).
            var bestSim = freeSims[0]
            var bestWait = (readyAt(state, bestSim, nowMs) - nowMs).coerceAtLeast(0L)
            for (i in 1 until freeSims.size) {
                val candidate = freeSims[i]
                val candidateWait = (readyAt(state, candidate, nowMs) - nowMs).coerceAtLeast(0L)
                if (candidateWait < bestWait) {
                    bestSim = candidate
                    bestWait = candidateWait
                }
            }
            if (bestWait == 0L) return SimDecision.Send(bestSim)

            // If another SIM is in flight, poll at most CONFIRM_POLL_MS so we react promptly
            // if it confirms (or hits partial-confirm grace) before the free SIM is due.
            val delayMs = if (earliestTimeoutRemaining != null) {
                minOf(bestWait, earliestTimeoutRemaining, CONFIRM_POLL_MS).coerceAtLeast(1L)
            } else {
                bestWait
            }
            return SimDecision.Wait(delayMs)
        }

        // Every usable SIM currently has an unconfirmed send in flight.
        val waitMs = minOf(earliestTimeoutRemaining ?: CONFIRM_POLL_MS, CONFIRM_POLL_MS).coerceAtLeast(1L)
        return SimDecision.Wait(waitMs)
    }

    /** The send started on [sim]: stamps device and per-SIM submission times and marks [sim] in flight. */
    fun started(state: SimRotationState, flight: SimInFlight): SimRotationState =
        state.copy(
            lastSim = flight.sim,
            lastSubmitAnyMs = flight.submittedAtMs,
            lastSubmitBySim = state.lastSubmitBySim + (flight.sim to flight.submittedAtMs),
            inFlightBySim = state.inFlightBySim + (flight.sim to flight)
        )

    /**
     * The radio finished with [sim] (confirmed, failed, or timed out): clears only its
     * in-flight slot without re-stamping submit gaps (no post-timeout double-gap penalty).
     */
    fun finished(state: SimRotationState, sim: Int): SimRotationState =
        state.copy(inFlightBySim = state.inFlightBySim - sim)

    /**
     * A send failed before hand-off to the radio (e.g. SmsManager threw).
     * Stamps only this SIM's gap so it cannot tight-loop, without penalizing other healthy SIMs.
     */
    fun failedBeforeStart(state: SimRotationState, sim: Int, nowMs: Long): SimRotationState =
        state.copy(
            lastSim = sim,
            lastSubmitBySim = state.lastSubmitBySim + (sim to nowMs),
            inFlightBySim = state.inFlightBySim - sim
        )
}

/**
 * Consecutive-failure tracking per SIM. Lives in memory on purpose: a paused
 * SIM comes back when the app restarts (e.g. after reloading its promo).
 */
class SimHealth(private val limit: Int = SimRotationPolicy.FAILURE_LIMIT) {
    private val streaks = HashMap<Int, Int>()
    private val paused = LinkedHashSet<Int>()

    /** @return true when this outcome paused the SIM. */
    fun record(sim: Int, outcome: SimOutcome): Boolean {
        when (outcome) {
            SimOutcome.SUCCESS -> streaks.remove(sim)
            SimOutcome.NEUTRAL -> Unit
            SimOutcome.SIM_FAILURE -> {
                val streak = (streaks[sim] ?: 0) + 1
                streaks[sim] = streak
                if (streak >= limit && paused.add(sim)) return true
            }
        }
        return false
    }

    fun isPaused(sim: Int): Boolean = sim in paused

    fun pausedSims(): Set<Int> = paused.toSet()

    fun failureStreak(sim: Int): Int = streaks[sim] ?: 0
}
