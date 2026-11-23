package com.vernu.sms.remotescreen

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewaySystemSetupTest {
    private val ours = "sms.gabay.online/com.vernu.sms.remotescreen.RemoteScreenService"

    @Test
    fun addsOurServiceToAnEmptyList() {
        assertEquals(ours, GatewaySystemSetup.mergeEnabledServices("", ours))
    }

    @Test
    fun keepsOtherEnabledServices() {
        val other = "com.google.android.marvin.talkback/.TalkBackService"
        assertEquals("$other:$ours", GatewaySystemSetup.mergeEnabledServices(other, ours))
    }

    @Test
    fun doesNotDuplicateWhenAlreadyEnabledInAnyForm() {
        val other = "com.example/.Svc"
        assertEquals("$ours:$other", GatewaySystemSetup.mergeEnabledServices("$ours:$other", ours))
        val shortForm = "com.example/.Svc"
        assertEquals(shortForm, GatewaySystemSetup.mergeEnabledServices(shortForm, "com.example/com.example.Svc"))
    }

    @Test
    fun dropsEmptyEntries() {
        assertEquals("a/b.C:$ours", GatewaySystemSetup.mergeEnabledServices(":a/b.C::", ours))
    }
}
