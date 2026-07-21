package com.vernu.sms.dtos

import com.vernu.sms.models.SMSPayload

class ClaimOutboxRequest {
    var limit: Int = 5
}

class ClaimOutboxData {
    var claimed: Int = 0
    var messages: List<SMSPayload>? = null
}

class ClaimOutboxResponse {
    var data: ClaimOutboxData? = null
}
