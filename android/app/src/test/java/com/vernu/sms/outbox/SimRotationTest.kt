package com.vernu.sms.outbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SimRotationTest {

    private val sim1 = 11
    private val sim2 = 22
    private val both = listOf(sim1, sim2)

    /** A real epoch time: a clock starting at 0 hid an overflow that froze the first send. */
    private val t0 = 1_760_500_000_000L

    /** Starts a send at [at] and confirms it (clearing in-flight without re-stamping submit gaps). */
    private fun sendAndConfirm(
        state: SimRotationState,
        usable: List<Int>,
        at: Long
    ): Pair<SimRotationState, Int> {
        val decision = SimRotationPolicy.decide(state, usable, at)
        assertTrue("expected a send at $at but got $decision", decision is SimDecision.Send)
        val sim = (decision as SimDecision.Send).sim
        val started = SimRotationPolicy.started(state, SimInFlight("sms@$at#1", sim, at))
        return SimRotationPolicy.finished(started, sim) to sim
    }

    @Test
    fun firstEverSendGoesOutImmediately() {
        // Regression: no submission history must never overflow the wait time.
        assertEquals(SimDecision.Send(sim1), SimRotationPolicy.decide(SimRotationState(), both, t0))
        assertEquals(SimDecision.Send(sim1), SimRotationPolicy.decide(SimRotationState(), listOf(sim1), t0))
        assertEquals(
            SimDecision.Send(SimRotationPolicy.DEFAULT_SIM),
            SimRotationPolicy.decide(SimRotationState(), listOf(SimRotationPolicy.DEFAULT_SIM), t0)
        )
    }

    @Test
    fun aSimWithNoHistoryOnlyWaitsForTheDeviceGap() {
        // sim2 has never sent; only the 10s phone gap since sim1's submission applies.
        val state = SimRotationState(lastSim = sim1, lastSubmitAnyMs = t0, lastSubmitBySim = mapOf(sim1 to t0))
        assertEquals(SimDecision.Wait(4_000), SimRotationPolicy.decide(state, both, t0 + 6_000))
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, both, t0 + 10_000))
    }

    @Test
    fun alternatesSimsTenSecondsApartAndTwentyPerSimRegardlessOfConfirmLatency() {
        var state = SimRotationState()
        val order = mutableListOf<Int>()
        for (at in listOf(t0, t0 + 10_000L, t0 + 20_000L, t0 + 30_000L)) {
            val (next, sim) = sendAndConfirm(state, both, at)
            order += sim
            state = next
        }
        assertEquals(listOf(sim1, sim2, sim1, sim2), order)
    }

    @Test
    fun nextSendPacesFromSubmissionNotConfirmationLatency() {
        // Handed to the radio at t0, confirmed by the network 4s later: sim2 still goes at t0 + 10s.
        val started = SimRotationPolicy.started(SimRotationState(), SimInFlight("a#1", sim1, t0))
        val confirmed = SimRotationPolicy.finished(started, sim1)
        assertEquals(SimDecision.Wait(6_000), SimRotationPolicy.decide(confirmed, both, t0 + 4_000))
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(confirmed, both, t0 + 10_000))
    }

    @Test
    fun slowOrHungSimInFlightDoesNotBlockOtherHealthySim() {
        // sim1 handed to radio at t0 and never confirms.
        var state = SimRotationPolicy.started(SimRotationState(), SimInFlight("a#1", sim1, t0))

        // Before 10s device gap, we poll (<= 1s because sim1 is in flight).
        val early = SimRotationPolicy.decide(state, both, t0 + 5_000)
        assertTrue(early is SimDecision.Wait)
        assertTrue((early as SimDecision.Wait).delayMs <= SimRotationPolicy.CONFIRM_POLL_MS)

        // At t0 + 10s: sim2 is free and ready immediately even while sim1 is still in flight!
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, both, t0 + 10_000))
        state = SimRotationPolicy.started(state, SimInFlight("b#1", sim2, t0 + 10_000))

        // While BOTH SIMs are in flight at t0 + 12s, wait polls <= 1s.
        val bothInFlight = SimRotationPolicy.decide(state, both, t0 + 12_000)
        assertTrue(bothInFlight is SimDecision.Wait)
        assertTrue((bothInFlight as SimDecision.Wait).delayMs <= SimRotationPolicy.CONFIRM_POLL_MS)

        // sim2 confirms at t0 + 14s; sim1 is still stuck at t0 + 30s -> sim2 sends again at t0 + 30s!
        state = SimRotationPolicy.finished(state, sim2)
        assertTrue(SimRotationPolicy.decide(state, both, t0 + 20_000) is SimDecision.Wait)
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, both, t0 + 30_000))
    }

    @Test
    fun sameSimNeverStacksTwoInFlightSends() {
        val started = SimRotationPolicy.started(SimRotationState(), SimInFlight("a#1", sim1, t0))
        // Even past SIM_GAP_MS (20s), single-SIM device refuses a second send on sim1 while in flight.
        val decision = SimRotationPolicy.decide(started, listOf(sim1), t0 + 30_000)
        assertTrue(decision is SimDecision.Wait)
        assertTrue((decision as SimDecision.Wait).delayMs in 1..SimRotationPolicy.CONFIRM_POLL_MS)
    }

    @Test
    fun timeoutClearsInFlightWithoutPostTimeoutDoubleGapPenalty() {
        // Single-SIM timeout at t0 + 60s must send next SMS immediately at t0 + 60s (NOT t0 + 80s).
        val flight1 = SimInFlight("a#1", sim1, t0)
        val started1 = SimRotationPolicy.started(SimRotationState(), flight1)
        assertEquals(SimDecision.TimedOut(flight1), SimRotationPolicy.decide(started1, listOf(sim1), t0 + 60_000))
        val cleared1 = SimRotationPolicy.finished(started1, sim1)
        assertEquals(SimDecision.Send(sim1), SimRotationPolicy.decide(cleared1, listOf(sim1), t0 + 60_000))

        // Dual-SIM timeout on sim1 at t0 + 60s must NOT add an extra 10s device gap onto sim2.
        val clearedDual = SimRotationPolicy.finished(started1, sim1)
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(clearedDual, both, t0 + 60_000))
    }

    @Test
    fun unconfirmedSendTimesOutAfterSixtySeconds() {
        val flight = SimInFlight("a#1", sim1, t0)
        val started = SimRotationPolicy.started(SimRotationState(), flight)
        assertTrue(SimRotationPolicy.decide(started, listOf(sim1), t0 + 59_999) is SimDecision.Wait)
        assertEquals(SimDecision.TimedOut(flight), SimRotationPolicy.decide(started, listOf(sim1), t0 + 60_000))
    }

    @Test
    fun clockJumpingBackwardsDoesNotStallTheInFlightWait() {
        val flight = SimInFlight("a#1", sim1, t0 + 100_000)
        val started = SimRotationPolicy.started(SimRotationState(), flight)
        assertEquals(SimDecision.TimedOut(flight), SimRotationPolicy.decide(started, both, t0 + 50_000))
    }

    @Test
    fun singleUsableSimKeepsTheTwentySecondGap() {
        val only = listOf(sim1)
        val (state, sim) = sendAndConfirm(SimRotationState(), only, t0)
        assertEquals(sim1, sim)
        assertEquals(SimDecision.Wait(10_000), SimRotationPolicy.decide(state, only, t0 + 10_000))
        assertEquals(SimDecision.Send(sim1), SimRotationPolicy.decide(state, only, t0 + 20_000))
    }

    @Test
    fun pausedSimDropsOutAndTheOtherKeepsTwentySecondGap() {
        var state = SimRotationState()
        state = sendAndConfirm(state, both, t0).first // sim1
        state = sendAndConfirm(state, both, t0 + 10_000).first // sim2
        // sim1 is now paused: only sim2 remains, 20s after its own submission.
        val onlySim2 = listOf(sim2)
        assertEquals(SimDecision.Wait(10_000), SimRotationPolicy.decide(state, onlySim2, t0 + 20_000))
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, onlySim2, t0 + 30_000))
    }

    @Test
    fun noUsableSimWhenAllArePaused() {
        assertEquals(SimDecision.NoUsableSim, SimRotationPolicy.decide(SimRotationState(), emptyList(), t0))
    }

    @Test
    fun submissionStampedInTheFutureIsIgnoredInsteadOfParkingTheQueue() {
        // The phone clock moved back an hour after the last submission.
        val later = t0 + 60 * 60_000L
        val state = SimRotationState(lastSim = sim2, lastSubmitAnyMs = later, lastSubmitBySim = mapOf(sim1 to later))
        assertEquals(SimDecision.Send(sim1), SimRotationPolicy.decide(state, both, t0))
    }

    @Test
    fun everyWaitIsBoundedByOneSimGap() {
        val state = SimRotationState(lastSim = sim2, lastSubmitAnyMs = t0, lastSubmitBySim = mapOf(sim1 to t0))
        listOf(t0, t0 + 1, t0 + 19_999, t0 + 20_000, t0 + 3_600_000).forEach { now ->
            val decision = SimRotationPolicy.decide(state, both, now)
            if (decision is SimDecision.Wait) {
                assertTrue("wait ${decision.delayMs} at $now", decision.delayMs in 1..SimRotationPolicy.SIM_GAP_MS)
            }
        }
    }

    @Test
    fun nextSimWrapsAndPreservesRoundRobinAfterLongIdle() {
        assertEquals(sim2, SimRotationPolicy.nextSim(both, sim1))
        assertEquals(sim1, SimRotationPolicy.nextSim(both, sim2))
        assertEquals(sim1, SimRotationPolicy.nextSim(both, 99))
        assertEquals(sim1, SimRotationPolicy.nextSim(both, null))

        // After a long idle where both SIMs have wait == 0, tie-breaking strictly alternates after lastSim.
        val idle = SimRotationState(
            lastSim = sim1,
            lastSubmitAnyMs = t0,
            lastSubmitBySim = mapOf(sim1 to t0, sim2 to t0 + 10_000)
        )
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(idle, both, t0 + 3_600_000))
    }

    @Test
    fun failedBeforeStartPacesOnlyFailedSimNotOtherHealthySim() {
        val state = SimRotationPolicy.failedBeforeStart(SimRotationState(), sim1, t0)
        // sim2 has no submission history and no device-gap penalty, so it can pick up immediately.
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, both, t0))
        // sim1 itself cannot tight-loop if it is the only SIM.
        assertEquals(SimDecision.Wait(SimRotationPolicy.SIM_GAP_MS), SimRotationPolicy.decide(state, listOf(sim1), t0))
    }

    @Test
    fun simIsPausedAfterFiveFailuresInARow() {
        val health = SimHealth()
        repeat(4) { assertFalse(health.record(sim1, SimOutcome.SIM_FAILURE)) }
        assertFalse(health.isPaused(sim1))
        assertTrue(health.record(sim1, SimOutcome.SIM_FAILURE))
        assertTrue(health.isPaused(sim1))
        assertFalse(health.isPaused(sim2))
    }

    @Test
    fun successResetsTheStreakButNeutralFailuresDoNot() {
        val health = SimHealth()
        repeat(4) { health.record(sim1, SimOutcome.SIM_FAILURE) }
        health.record(sim1, SimOutcome.SUCCESS)
        repeat(4) { health.record(sim1, SimOutcome.SIM_FAILURE) }
        assertFalse(health.isPaused(sim1))

        // A wrong number in between neither counts nor resets.
        health.record(sim1, SimOutcome.NEUTRAL)
        assertEquals(4, health.failureStreak(sim1))
        health.record(sim1, SimOutcome.SIM_FAILURE)
        assertTrue(health.isPaused(sim1))
    }

    @Test
    fun pausedSimStaysPausedUntilRestart() {
        val health = SimHealth()
        repeat(5) { health.record(sim1, SimOutcome.SIM_FAILURE) }
        health.record(sim1, SimOutcome.SUCCESS)
        assertTrue(health.isPaused(sim1))
        assertFalse(SimHealth().isPaused(sim1)) // a fresh process starts clean
    }

    private fun submitted(
        sendSeq: Int = 1,
        sentMask: Long = 0,
        failedMask: Long = 0,
        state: LocalState = LocalState.SUBMITTED,
        submittedAt: Long = t0,
        updatedAt: Long = t0,
        errorCode: String? = null
    ) = OutboxEntry(
        localId = "sms1", smsId = "sms1", batchId = null, recipient = "+639170000000", message = "hi",
        simSubscriptionId = null, attempt = 1, sendSeq = sendSeq, expiresAtMs = null, issuedAtMs = null,
        leaseUntilMs = null, receivedAtMs = submittedAt, receivedElapsedMs = 0, state = state, partsTotal = 3,
        partsSentMask = sentMask, partsFailedMask = failedMask, partsDeliveredMask = 0,
        submittedAtMs = submittedAt, completedAtMs = null, requestedSimId = null, resolvedSimId = sim1,
        errorCode = errorCode, errorMessage = null, updatedAtMs = updatedAt
    )

    @Test
    fun evaluateInFlightTimeoutFinalizesPartialConfirmedMultipartAfterGraceWindow() {
        val flight = SimInFlight("sms1#1", sim1, t0)
        // Parts 0 and 1 confirmed by t0 + 4s; part 2 never arrives.
        val partial = submitted(sentMask = 0b011, updatedAt = t0 + 4_000)

        val beforeGrace = SimRotationPolicy.evaluateInFlightTimeout(flight, partial, t0 + 23_999)
        assertEquals(InFlightTimeoutKind.NONE, beforeGrace.first)
        assertEquals(1L, beforeGrace.second)

        val atGrace = SimRotationPolicy.evaluateInFlightTimeout(flight, partial, t0 + 24_000)
        assertEquals(InFlightTimeoutKind.PARTIAL_CONFIRMED, atGrace.first)
        assertEquals(0L, atGrace.second)

        // Late partial confirmation (at t0 + 50s) is still capped at CONFIRM_TIMEOUT_MS (t0 + 60s).
        val latePartial = submitted(sentMask = 0b001, updatedAt = t0 + 50_000)
        assertEquals(
            InFlightTimeoutKind.NONE to 1_000L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, latePartial, t0 + 59_000)
        )
        assertEquals(
            InFlightTimeoutKind.PARTIAL_CONFIRMED to 0L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, latePartial, t0 + 60_000)
        )
    }

    @Test
    fun evaluateInFlightTimeoutClassifiesUnconfirmedPartialFailedAndAlreadyFinished() {
        val flight = SimInFlight("sms1#1", sim1, t0)

        // Zero parts confirmed: NONE before 60s, UNCONFIRMED at 60s.
        val zero = submitted()
        assertEquals(
            InFlightTimeoutKind.NONE to 1L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, zero, t0 + 59_999)
        )
        assertEquals(
            InFlightTimeoutKind.UNCONFIRMED to 0L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, zero, t0 + 60_000)
        )

        // One part explicitly failed, remaining part missing: PARTIAL_FAILED at 60s.
        val partialFail = submitted(sentMask = 0b001, failedMask = 0b010, errorCode = "1")
        assertEquals(
            InFlightTimeoutKind.PARTIAL_FAILED to 0L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, partialFail, t0 + 60_000)
        )

        // Already finished or superseded in SQLite: clears immediately without blaming SIM.
        assertEquals(
            InFlightTimeoutKind.ALREADY_FINISHED to 0L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, null, t0 + 1_000)
        )
        assertEquals(
            InFlightTimeoutKind.ALREADY_FINISHED to 0L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, submitted(state = LocalState.SENT), t0 + 1_000)
        )
        assertEquals(
            InFlightTimeoutKind.ALREADY_FINISHED to 0L,
            SimRotationPolicy.evaluateInFlightTimeout(flight, submitted(sendSeq = 2), t0 + 1_000)
        )
    }

    @Test
    fun timeoutWithNoConfirmationAtAllBlamesTheSim() {
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.timeoutOutcome(submitted(), 1))
    }

    @Test
    fun timeoutOfALongSmsWithConfirmedPartsDoesNotBlameTheSim() {
        // Parts 1 and 2 confirmed, part 3 never reported (seen on some phones).
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.timeoutOutcome(submitted(sentMask = 0b011), 1))
        // A part that failed outright still counts against the SIM.
        assertEquals(
            SimOutcome.SIM_FAILURE,
            SimRotationPolicy.timeoutOutcome(submitted(sentMask = 0b001, failedMask = 0b010, errorCode = "1"), 1)
        )
    }

    @Test
    fun timeoutOfAnAnsweredOrSupersededSendIsNeutral() {
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.timeoutOutcome(null, 1))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.timeoutOutcome(submitted(sendSeq = 2), 1))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.timeoutOutcome(submitted(state = LocalState.SENT), 1))
    }

    @Test
    fun outcomesSeparateSimProblemsFromRecipientProblems() {
        assertEquals(SimOutcome.SUCCESS, SimRotationPolicy.outcomeOf(LocalState.SENT, null))
        assertEquals(SimOutcome.SUCCESS, SimRotationPolicy.outcomeOf(LocalState.DELIVERED, null))
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.outcomeOf(LocalState.UNKNOWN, StatusReporter.ERROR_CONFIRM_TIMEOUT))
        // RESULT_ERROR_GENERIC_FAILURE (no load), RADIO_OFF, NO_SERVICE: the SIM's fault.
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.outcomeOf(LocalState.FAILED, "1"))
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.outcomeOf(LocalState.FAILED, "2"))
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.outcomeOf(LocalState.FAILED, "4"))
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.outcomeOf(LocalState.FAILED, StatusReporter.ERROR_SENDING_EXCEPTION))
        // NULL_PDU, FDN, short codes: the recipient/message.
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.outcomeOf(LocalState.FAILED, "3"))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.outcomeOf(LocalState.FAILED, "6"))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.outcomeOf(LocalState.FAILED, "7"))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.outcomeOf(LocalState.FAILED, "8"))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.outcomeOf(LocalState.FAILED, StatusReporter.ERROR_INVALID_RECIPIENT))
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.outcomeOf(LocalState.FAILED, StatusReporter.ERROR_PERMISSION_DENIED))
    }
}
