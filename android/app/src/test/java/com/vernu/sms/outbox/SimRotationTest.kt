package com.vernu.sms.outbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SimRotationTest {

    private val sim1 = 11
    private val sim2 = 22
    private val both = listOf(sim1, sim2)

    /** Starts a send at [at] and confirms it [confirmAfterMs] later. */
    private fun sendAndConfirm(
        state: SimRotationState,
        usable: List<Int>,
        at: Long,
        confirmAfterMs: Long = 0
    ): Pair<SimRotationState, Int> {
        val decision = SimRotationPolicy.decide(state, usable, at)
        assertTrue("expected a send at $at but got $decision", decision is SimDecision.Send)
        val sim = (decision as SimDecision.Send).sim
        val started = SimRotationPolicy.started(state, SimInFlight("sms@$at#1", sim, at))
        return SimRotationPolicy.finished(started, sim, at + confirmAfterMs) to sim
    }

    @Test
    fun alternatesSimsTenSecondsApartAndTwentyPerSim() {
        var state = SimRotationState()
        val order = mutableListOf<Int>()
        for (at in listOf(0L, 10_000L, 20_000L, 30_000L)) {
            val (next, sim) = sendAndConfirm(state, both, at)
            order += sim
            state = next
        }
        assertEquals(listOf(sim1, sim2, sim1, sim2), order)
    }

    @Test
    fun nextSendWaitsTenSecondsAfterConfirmationNotAfterHandOff() {
        // Handed to the radio at 0, confirmed by the network at 4s.
        val (state, _) = sendAndConfirm(SimRotationState(), both, 0, confirmAfterMs = 4_000)
        assertEquals(SimDecision.Wait(4_000), SimRotationPolicy.decide(state, both, 10_000))
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, both, 14_000))
    }

    @Test
    fun waitsForConfirmationWhileASendIsInFlight() {
        val started = SimRotationPolicy.started(SimRotationState(), SimInFlight("a#1", sim1, 0))
        val decision = SimRotationPolicy.decide(started, both, 30_000)
        assertTrue(decision is SimDecision.Wait)
        assertTrue((decision as SimDecision.Wait).delayMs <= SimRotationPolicy.CONFIRM_POLL_MS)
    }

    @Test
    fun unconfirmedSendTimesOutAfterSixtySeconds() {
        val flight = SimInFlight("a#1", sim1, 0)
        val started = SimRotationPolicy.started(SimRotationState(), flight)
        assertTrue(SimRotationPolicy.decide(started, both, 59_999) is SimDecision.Wait)
        assertEquals(SimDecision.TimedOut(flight), SimRotationPolicy.decide(started, both, 60_000))
    }

    @Test
    fun clockJumpingBackwardsDoesNotStallTheInFlightWait() {
        val flight = SimInFlight("a#1", sim1, 100_000)
        val started = SimRotationPolicy.started(SimRotationState(), flight)
        assertEquals(SimDecision.TimedOut(flight), SimRotationPolicy.decide(started, both, 50_000))
    }

    @Test
    fun singleUsableSimKeepsTheTwentySecondGap() {
        val only = listOf(sim1)
        val (state, sim) = sendAndConfirm(SimRotationState(), only, 0)
        assertEquals(sim1, sim)
        assertEquals(SimDecision.Wait(10_000), SimRotationPolicy.decide(state, only, 10_000))
        assertEquals(SimDecision.Send(sim1), SimRotationPolicy.decide(state, only, 20_000))
    }

    @Test
    fun pausedSimDropsOutAndTheOtherKeepsTwentySecondGap() {
        var state = SimRotationState()
        state = sendAndConfirm(state, both, 0).first // sim1
        state = sendAndConfirm(state, both, 10_000).first // sim2
        // sim1 is now paused: only sim2 remains, 20s after its own confirmation.
        val onlySim2 = listOf(sim2)
        assertEquals(SimDecision.Wait(10_000), SimRotationPolicy.decide(state, onlySim2, 20_000))
        assertEquals(SimDecision.Send(sim2), SimRotationPolicy.decide(state, onlySim2, 30_000))
    }

    @Test
    fun noUsableSimWhenAllArePaused() {
        assertEquals(SimDecision.NoUsableSim, SimRotationPolicy.decide(SimRotationState(), emptyList(), 0))
    }

    @Test
    fun wallClockJumpForwardInStateNeverParksTheQueueBeyondOneSimGap() {
        val state = SimRotationState(lastSim = sim2, lastConfirmAnyMs = 10_000_000, lastConfirmBySim = mapOf(sim1 to 10_000_000))
        val decision = SimRotationPolicy.decide(state, both, 0)
        assertEquals(SimDecision.Wait(SimRotationPolicy.SIM_GAP_MS), decision)
    }

    @Test
    fun nextSimWrapsAndRecoversFromAnUnknownLastSim() {
        assertEquals(sim2, SimRotationPolicy.nextSim(both, sim1))
        assertEquals(sim1, SimRotationPolicy.nextSim(both, sim2))
        assertEquals(sim1, SimRotationPolicy.nextSim(both, 99))
        assertEquals(sim1, SimRotationPolicy.nextSim(both, null))
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

    private fun submitted(sendSeq: Int = 1, sentMask: Long = 0, failedMask: Long = 0, state: LocalState = LocalState.SUBMITTED) =
        OutboxEntry(
            localId = "sms1", smsId = "sms1", batchId = null, recipient = "+639170000000", message = "hi",
            simSubscriptionId = null, attempt = 1, sendSeq = sendSeq, expiresAtMs = null, issuedAtMs = null,
            leaseUntilMs = null, receivedAtMs = 0, receivedElapsedMs = 0, state = state, partsTotal = 3,
            partsSentMask = sentMask, partsFailedMask = failedMask, partsDeliveredMask = 0,
            submittedAtMs = 0, completedAtMs = null, requestedSimId = null, resolvedSimId = sim1,
            errorCode = null, errorMessage = null, updatedAtMs = 0
        )

    @Test
    fun timeoutWithNoConfirmationAtAllBlamesTheSim() {
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.timeoutOutcome(submitted(), 1))
    }

    @Test
    fun timeoutOfALongSmsWithConfirmedPartsDoesNotBlameTheSim() {
        // Parts 1 and 2 confirmed, part 3 never reported (seen on some phones).
        assertEquals(SimOutcome.NEUTRAL, SimRotationPolicy.timeoutOutcome(submitted(sentMask = 0b011), 1))
        // A part that failed outright still counts against the SIM.
        assertEquals(SimOutcome.SIM_FAILURE, SimRotationPolicy.timeoutOutcome(submitted(sentMask = 0b001, failedMask = 0b010), 1))
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
