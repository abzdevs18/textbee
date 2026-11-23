package com.vernu.sms.helpers

import org.junit.Assert.*
import org.junit.Test

class PlatformAlertPayloadTest {
    private val now = 1700000000000L
    private fun envelope() = mapOf("type" to "platform_alert", "alertId" to "alert_1", "title" to "Gradesheet degraded", "body" to "Open the owner console", "severity" to "degraded", "issuedAt" to now.toString(), "expiresAt" to (now + 300000).toString(), "url" to "https://app.example.test/admin/service-status")

    @Test fun parsesGeneralAlertAndSafeLink() {
        val value = PlatformAlertPayload.parse(envelope(), now)
        assertEquals("alert_1", value?.id)
        assertEquals("degraded", value?.severity)
        assertEquals("https://app.example.test/admin/service-status", value?.url)
    }
    @Test fun acceptsRecoveryAndNoLink() {
        assertNotNull(PlatformAlertPayload.parse(envelope().minus("url") + ("severity" to "recovered"), now))
    }
    @Test fun rejectsExpiredFutureAndUnboundedLifetimes() {
        assertNull(PlatformAlertPayload.parse(envelope() + ("expiresAt" to (now - 1).toString()), now))
        assertNull(PlatformAlertPayload.parse(envelope() + ("issuedAt" to (now + 120000).toString()), now))
        assertNull(PlatformAlertPayload.parse(envelope() + ("expiresAt" to (now + 1000000).toString()), now))
    }
    @Test fun rejectsUnsafeOrCredentialBearingLinks() {
        for (url in listOf("javascript:alert(1)", "intent://settings", "http://example.test", "https://user:secret@example.test")) {
            assertNull(PlatformAlertPayload.parse(envelope() + ("url" to url), now))
        }
    }
    @Test fun boundsTextAndRejectsMissingOrUnknownMessageTypes() {
        assertNull(PlatformAlertPayload.parse(envelope() + ("body" to "x".repeat(321)), now))
        assertNull(PlatformAlertPayload.parse(envelope().minus("alertId"), now))
        assertNull(PlatformAlertPayload.parse(envelope() + ("type" to "work_available"), now))
        assertNull(PlatformAlertPayload.parse(envelope() + ("severity" to "unknown"), now))
    }
}
