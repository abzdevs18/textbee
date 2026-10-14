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

/** Pacing memory of the rotation; survives app restarts. */
data class SimRotationState(
    /** SIM the last send was started on; the next send uses the one after it. */
    val lastSim: Int? = null,
    /** When the network last confirmed (or the confirmation timed out) on any SIM. */
    val lastConfirmAnyMs: Long? = null,
    val lastConfirmBySim: Map<Int, Long> = emptyMap(),
    val inFlight: SimInFlight? = null
)

sealed class SimDecision {
    data class Send(val sim: Int) : SimDecision()
    data class Wait(val delayMs: Long) : SimDecision()

    /** The in-flight send was never confirmed; record it as a SIM failure, then decide again. */
    data class TimedOut(val inFlight: SimInFlight) : SimDecision()

    /** Every SIM is paused (or none is present). */
    object NoUsableSim : SimDecision()
}

/**
 * Alternating dual-SIM sending (pure, unit-tested):
 * - one SMS at a time; the next waits for the network to confirm the previous one,
 * - SIM 1 → SIM 2 → SIM 1 …, at least [DEVICE_GAP_MS] after the last confirmation
 *   on the phone and [SIM_GAP_MS] after the last confirmation on the same SIM
 *   (so a phone with a single usable SIM sends every 20 seconds),
 * - a SIM that fails [FAILURE_LIMIT] sends in a row is paused until the app restarts.
 */
object SimRotationPolicy {
    const val DEVICE_GAP_MS = 10_000L
    const val SIM_GAP_MS = 20_000L
    const val CONFIRM_TIMEOUT_MS = 60_000L
    const val FAILURE_LIMIT = 5

    /** Stand-in id when Android does not list SIMs: the phone's default SMS SIM. */
    const val DEFAULT_SIM = -1

    /** While a send is unconfirmed, look again this often so a confirmation is acted on quickly. */
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

    /** Classifies the final state of an outbox entry. */
    fun outcomeOf(state: LocalState, errorCode: String?): SimOutcome = when (state) {
        LocalState.SENT, LocalState.DELIVERED -> SimOutcome.SUCCESS
        LocalState.FAILED -> outcomeOfError(errorCode)
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
        return if (entry.partsSentMask != 0L && entry.partsFailedMask == 0L) {
            SimOutcome.NEUTRAL
        } else {
            SimOutcome.SIM_FAILURE
        }
    }

    /** The SIM after [lastSim] in [usable] (slot order), wrapping around. */
    fun nextSim(usable: List<Int>, lastSim: Int?): Int? {
        if (usable.isEmpty()) return null
        val index = usable.indexOf(lastSim)
        return if (index < 0) usable[0] else usable[(index + 1) % usable.size]
    }

    /** Earliest time [sim] may send; clamped so a wall-clock jump never parks the queue for long. */
    fun readyAt(state: SimRotationState, sim: Int, nowMs: Long): Long {
        val afterDevice = state.lastConfirmAnyMs?.plus(DEVICE_GAP_MS) ?: Long.MIN_VALUE
        val afterSim = state.lastConfirmBySim[sim]?.plus(SIM_GAP_MS) ?: Long.MIN_VALUE
        return maxOf(afterDevice, afterSim).coerceAtMost(nowMs + SIM_GAP_MS)
    }

    fun decide(state: SimRotationState, usable: List<Int>, nowMs: Long): SimDecision {
        state.inFlight?.let { flight ->
            val waited = nowMs - flight.submittedAtMs
            // A clock that jumped backwards (waited < 0) counts as timed out rather than stalling.
            return if (waited in 0 until CONFIRM_TIMEOUT_MS) {
                SimDecision.Wait(minOf(CONFIRM_TIMEOUT_MS - waited, CONFIRM_POLL_MS))
            } else {
                SimDecision.TimedOut(flight)
            }
        }
        val sim = nextSim(usable, state.lastSim) ?: return SimDecision.NoUsableSim
        val waitMs = readyAt(state, sim, nowMs) - nowMs
        return if (waitMs > 0) SimDecision.Wait(waitMs) else SimDecision.Send(sim)
    }

    /** The send started on [sim]. */
    fun started(state: SimRotationState, flight: SimInFlight): SimRotationState =
        state.copy(lastSim = flight.sim, inFlight = flight)

    /** The radio finished with [sim] at [atMs] (confirmed, failed or timed out): start its gaps. */
    fun finished(state: SimRotationState, sim: Int, atMs: Long): SimRotationState =
        state.copy(
            lastConfirmAnyMs = atMs,
            lastConfirmBySim = state.lastConfirmBySim + (sim to atMs),
            inFlight = null
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
