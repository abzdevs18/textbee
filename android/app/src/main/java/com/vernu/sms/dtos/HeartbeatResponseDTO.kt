package com.vernu.sms.dtos

class HeartbeatResponseDTO {
    @JvmField var success: Boolean = false
    @JvmField var fcmTokenUpdated: Boolean = false
    @JvmField var lastHeartbeat: Long = 0
    @JvmField var name: String? = null
    /** Server source of truth for gateway on/off (web can disable remotely). */
    @JvmField var enabled: Boolean? = null
    @JvmField var outboxClaimed: Int = 0
}
