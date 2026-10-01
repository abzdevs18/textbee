package com.vernu.sms.outbox

import com.google.gson.Gson
import com.vernu.sms.dtos.HeartbeatResponseDTO
import com.vernu.sms.ui.messages.MessageStatusMapper
import com.vernu.sms.ui.messages.StatusTone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxLogicTest {

    private val minute = 60_000L

    @Test
    fun heartbeatResponseWithIsoTimestampParses() {
        // The API serialises lastHeartbeat as a Date; a numeric field made Gson
        // throw on every heartbeat, which silently disabled the outbox pull.
        val body = """{"success":true,"fcmTokenUpdated":false,"lastHeartbeat":"2026-10-01T04:30:00.000Z","name":"Front desk","outboxPending":3,"enabled":true}"""
        val dto = Gson().fromJson(body, HeartbeatResponseDTO::class.java)
        assertEquals(true, dto.enabled)
        assertEquals(3, dto.outboxPending)
        assertEquals("2026-10-01T04:30:00.000Z", dto.lastHeartbeat)
    }

    @Test
    fun serverTimeParsesIsoAndEpoch() {
        assertEquals(1_790_829_000_000L, ServerTime.parse("2026-10-01T04:30:00.000Z"))
        assertEquals(1_790_829_000_000L, ServerTime.parse("2026-10-01T04:30:00Z"))
        assertEquals(1_790_829_000_000L, ServerTime.parse("1790829000000"))
        assertNull(ServerTime.parse("not a date"))
        assertNull(ServerTime.parse(null))
    }

    @Test
    fun expiryUsesServerTimeNotThePhoneClock() {
        val issuedAt = 1_000_000_000_000L
        val expiresAt = issuedAt + 60 * minute
        // Phone clock is three hours fast: a naive wall-clock check would refuse it.
        val phoneWall = issuedAt + 180 * minute
        val entry = entry(expiresAt = expiresAt, issuedAt = issuedAt, receivedAt = phoneWall, receivedElapsed = 5_000_000)

        assertFalse(ExpiryClock.isExpired(entry, phoneWall + 10 * minute, 5_000_000 + 10 * minute))
        assertTrue(ExpiryClock.isExpired(entry, phoneWall + 61 * minute, 5_000_000 + 61 * minute))
    }

    @Test
    fun expiryAfterRebootFallsBackToSkewCorrectedWallClock() {
        val issuedAt = 1_000_000_000_000L
        val expiresAt = issuedAt + 60 * minute
        val phoneWall = issuedAt + 180 * minute
        val entry = entry(expiresAt = expiresAt, issuedAt = issuedAt, receivedAt = phoneWall, receivedElapsed = 50 * minute)

        // Rebooted: elapsed restarted near zero.
        assertFalse(ExpiryClock.isExpired(entry, phoneWall + 20 * minute, 2 * minute))
        assertTrue(ExpiryClock.isExpired(entry, phoneWall + 70 * minute, 2 * minute))
    }

    @Test
    fun legacyCommandsWithoutIssuedAtUseTheWallClock() {
        val now = 2_000_000_000_000L
        assertTrue(ExpiryClock.isExpired(entry(expiresAt = now - 1, issuedAt = null, receivedAt = now, receivedElapsed = 0), now, 0))
        assertFalse(ExpiryClock.isExpired(entry(expiresAt = null, issuedAt = null, receivedAt = now, receivedElapsed = 0), now, 0))
    }

    @Test
    fun multipartCompletesOnlyWhenEveryPartReported() {
        val expected = PartMath.expected(partsTotal = 3, reportedCount = 3)
        var mask = 0L
        mask = mask or PartMath.bit(0)
        mask = mask or PartMath.bit(2)
        assertFalse(PartMath.isComplete(mask, expected))
        mask = mask or PartMath.bit(2) // duplicate callback for the same part
        assertFalse(PartMath.isComplete(mask, expected))
        mask = mask or PartMath.bit(1)
        assertTrue(PartMath.isComplete(mask, expected))
    }

    @Test
    fun statusDistinguishesServerQueueFromPhoneQueue() {
        val serverQueued = MessageStatusMapper.describe("pending", "NO_ELIGIBLE_DEVICE", "Waiting for a free eligible device", null, null)
        assertEquals("Queued", serverQueued.label)
        assertEquals("Waiting for a free eligible device", serverQueued.detail)

        assertEquals("Waiting for phone", MessageStatusMapper.describe("dispatched", null, null, null, null).label)
        assertEquals("Queued on phone", MessageStatusMapper.describe("dispatched", null, null, LocalState.QUEUED, null).label)
        assertEquals("Sending", MessageStatusMapper.describe("dispatched", null, null, LocalState.SUBMITTED, null).label)

        val sentLocally = MessageStatusMapper.describe("dispatched", null, null, LocalState.SENT, null)
        assertEquals("Sent", sentLocally.label)
        assertEquals(StatusTone.SENT, sentLocally.tone)
    }

    @Test
    fun terminalServerStatusesAreNotShownAsPending() {
        assertEquals("Expired", MessageStatusMapper.describe("canceled", "EXPIRED_MAX_AGE", null, null, null).label)
        assertEquals("Canceled", MessageStatusMapper.describe("canceled", null, null, null, null).label)
        assertEquals("No confirmation", MessageStatusMapper.describe("unknown", null, null, null, null).label)
        assertEquals(StatusTone.ERROR, MessageStatusMapper.describe("failed", "1", "No credit", null, null).tone)
        assertEquals("Delivered", MessageStatusMapper.describe("delivered", null, null, null, null).label)
    }

    // --- OutboxPolicy: duplicates never cause a second send unless re-issued ---

    private val now = 2_000_000_000_000L

    private fun command(attempt: Int = 1, leaseUntil: Long? = null) = IncomingCommand(
        localId = "sms1", smsId = "sms1", batchId = "b1", recipient = "+639000000000",
        message = "hello", simSubscriptionId = null, attempt = attempt,
        expiresAtMs = now + 60 * minute, issuedAtMs = now, leaseUntilMs = leaseUntil, source = "test"
    )

    @Test
    fun newCommandIsInserted() {
        assertEquals(AcceptAction.INSERT, OutboxPolicy.decideAccept(null, command(), now).action)
    }

    @Test
    fun duplicateOfAQueuedCommandOnlyRefreshesOnANewerAttempt() {
        val queued = entry(state = LocalState.QUEUED, attempt = 1)
        assertEquals(AcceptAction.NONE, OutboxPolicy.decideAccept(queued, command(attempt = 1), now).action)
        val newer = OutboxPolicy.decideAccept(queued, command(attempt = 2), now)
        assertEquals(AcceptAction.REFRESH, newer.action)
        assertEquals(AcceptResult.AlreadyQueued, newer.result)
    }

    @Test
    fun commandOnTheRadioIsResentOnlyAfterTheCallbackTimeoutAndANewerAttempt() {
        val submitted = entry(state = LocalState.SUBMITTED, attempt = 1, submittedAt = now - minute)
        // Same attempt (FCM + claim, resync): never resend.
        assertEquals(AcceptAction.NONE, OutboxPolicy.decideAccept(submitted, command(attempt = 1), now).action)
        // Newer attempt soon after submit: the running send serves it.
        val adopt = OutboxPolicy.decideAccept(submitted, command(attempt = 2), now)
        assertEquals(AcceptAction.BUMP_ATTEMPT, adopt.action)
        assertEquals(AcceptResult.InFlight, adopt.result)
        // Newer attempt after 10 minutes without any SENT callback: deliberate retry.
        val stale = entry(state = LocalState.SUBMITTED, attempt = 1, submittedAt = now - 11 * minute)
        assertEquals(AcceptAction.REQUEUE, OutboxPolicy.decideAccept(stale, command(attempt = 2), now).action)
    }

    @Test
    fun finishedSendsAreReReportedNotResent() {
        val sent = entry(state = LocalState.SENT, attempt = 1)
        val again = OutboxPolicy.decideAccept(sent, command(attempt = 3), now)
        assertEquals(AcceptAction.BUMP_ATTEMPT, again.action)
        assertTrue(again.result is AcceptResult.Rereport)

        val failed = entry(state = LocalState.FAILED, attempt = 1)
        assertTrue(OutboxPolicy.decideAccept(failed, command(attempt = 1), now).result is AcceptResult.Rereport)
        assertEquals(AcceptAction.REQUEUE, OutboxPolicy.decideAccept(failed, command(attempt = 2), now).action)
    }

    @Test
    fun lapsedCommandsWaitForARealReIssue() {
        val lapsed = entry(state = LocalState.LAPSED, attempt = 1, leaseUntil = now + minute)
        assertEquals(AcceptResult.Stale, OutboxPolicy.decideAccept(lapsed, command(attempt = 1, leaseUntil = now + minute), now).result)
        assertEquals(AcceptAction.REQUEUE, OutboxPolicy.decideAccept(lapsed, command(attempt = 2), now).action)
        assertEquals(AcceptAction.REQUEUE, OutboxPolicy.decideAccept(lapsed, command(attempt = 1, leaseUntil = now + 5 * minute), now).action)
    }

    @Test
    fun leaseIsJudgedOnServerTimeWithAStartMargin() {
        val issuedAt = 1_000_000_000_000L
        // Phone clock 2h fast; lease 10 minutes from issue.
        val leased = entry(
            state = LocalState.QUEUED, issuedAt = issuedAt, receivedAt = issuedAt + 120 * minute,
            receivedElapsed = 1_000_000, leaseUntil = issuedAt + 10 * minute
        )
        assertFalse(OutboxPolicy.isLeaseLapsed(leased, issuedAt + 125 * minute, 1_000_000 + 5 * minute))
        // Within the 15 s start margin of the lease end.
        assertTrue(OutboxPolicy.isLeaseLapsed(leased, issuedAt + 129 * minute + 50_000, 1_000_000 + 9 * minute + 50_000))
        assertFalse(OutboxPolicy.isLeaseLapsed(entry(state = LocalState.QUEUED), now, 0))
    }

    @Test
    fun multipartOutcomeWaitsForEveryPartAndFailsIfAnyPartFailed() {
        val submitted = entry(state = LocalState.SUBMITTED, sendSeq = 2, partsTotal = 3)
        // Callback from an older send of the same SMS is ignored.
        assertNull(OutboxPolicy.decideSentPart(submitted, 1, 0, 3, ok = true))

        val first = OutboxPolicy.decideSentPart(submitted, 2, 0, 3, ok = true)!!
        assertNull(first.finalState)
        val second = OutboxPolicy.decideSentPart(
            submitted.copy(partsSentMask = first.sentMask), 2, 1, 3, ok = false
        )!!
        assertNull(second.finalState)
        assertTrue(second.recordError)
        val last = OutboxPolicy.decideSentPart(
            submitted.copy(partsSentMask = second.sentMask, partsFailedMask = second.failedMask, errorCode = "1"),
            2, 2, 3, ok = true
        )!!
        assertEquals(LocalState.FAILED, last.finalState)
        assertFalse(last.recordError) // first error is kept

        val allOk = OutboxPolicy.decideSentPart(
            submitted.copy(partsSentMask = PartMath.bit(0) or PartMath.bit(1)), 2, 2, 3, ok = true
        )!!
        assertEquals(LocalState.SENT, allOk.finalState)
    }

    private fun entry(
        expiresAt: Long? = null,
        issuedAt: Long? = null,
        receivedAt: Long = now,
        receivedElapsed: Long = 0,
        state: LocalState = LocalState.QUEUED,
        attempt: Int = 1,
        submittedAt: Long? = null,
        leaseUntil: Long? = null,
        sendSeq: Int = 0,
        partsTotal: Int = 0
    ) = OutboxEntry(
        localId = "sms1", smsId = "sms1", batchId = null, recipient = "+639000000000",
        message = "hello", simSubscriptionId = null, attempt = attempt, sendSeq = sendSeq,
        expiresAtMs = expiresAt, issuedAtMs = issuedAt, leaseUntilMs = leaseUntil,
        receivedAtMs = receivedAt, receivedElapsedMs = receivedElapsed, state = state,
        partsTotal = partsTotal, partsSentMask = 0, partsFailedMask = 0, partsDeliveredMask = 0,
        submittedAtMs = submittedAt, completedAtMs = null, requestedSimId = null,
        resolvedSimId = null, errorCode = null, errorMessage = null, updatedAtMs = receivedAt
    )
}
