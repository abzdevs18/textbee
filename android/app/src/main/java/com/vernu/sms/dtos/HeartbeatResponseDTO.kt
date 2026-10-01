package com.vernu.sms.dtos

class HeartbeatResponseDTO {
    @JvmField var success: Boolean = false
    @JvmField var fcmTokenUpdated: Boolean = false
    /**
     * Server timestamp. The API serialises a Date (ISO-8601 string); declaring
     * this as a number made Gson throw on every heartbeat response, so the
     * app treated each heartbeat as failed and skipped the follow-up outbox pull.
     */
    @JvmField var lastHeartbeat: String? = null
    @JvmField var name: String? = null
    /** Server source of truth for gateway on/off (web can disable remotely). */
    @JvmField var enabled: Boolean? = null
    /** Outbound SMS waiting in the central outbox — pull them via claim-outbox. */
    @JvmField var outboxPending: Int = 0
}
