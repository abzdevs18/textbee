package com.vernu.sms.dtos

import com.vernu.sms.models.SMSPayload

class ClaimOutboxRequest {
    var limit: Int = 5

    /**
     * Ask the server to hand back SMS it already dispatched to this phone but
     * never got a report for (their FCM push may never have arrived). Safe
     * because the local outbox ignores commands it already has.
     */
    var resync: Boolean = true
}

class ClaimOutboxData {
    var claimed: Int = 0
    var redelivered: Int = 0
    var messages: List<SMSPayload>? = null
}

class ClaimOutboxResponse {
    var data: ClaimOutboxData? = null
}
