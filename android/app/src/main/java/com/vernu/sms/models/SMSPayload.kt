package com.vernu.sms.models

class SMSPayload {
    var deviceId: String? = null
    var targetDeviceId: String? = null
    var recipients: Array<String?>? = null
    var message: String? = null
    var smsId: String? = null
    var smsBatchId: String? = null
    var simSubscriptionId: Int? = null
    /** ISO-8601 expiry from server — never send after this (2h max age policy). */
    var expiresAt: String? = null
    /** Server time when the command was issued; lets the phone judge expiry without trusting its clock. */
    var issuedAt: String? = null
    /** Server dispatch attempt; a higher value on a known SMS is a deliberate retry. */
    var attempt: Int? = null
    /** ISO-8601 end of this phone's lease; a send must not *start* after it. */
    var leaseUntil: String? = null

    // Legacy fields — no longer actively used but kept for backward compatibility
    var receivers: Array<String?>? = null
    var smsBody: String? = null
}
