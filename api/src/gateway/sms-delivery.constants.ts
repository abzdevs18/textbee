/**
 * SMS delivery reliability knobs.
 * Goal: get every message out as fast as possible across any free device.
 */

/** Recent failure window for device health (minutes). */
export const DEVICE_FAILURE_COOLDOWN_MINUTES = 5

/** Failures/unknowns inside the cooldown window that mark a device temporarily unhealthy. */
export const DEVICE_FAILURE_THRESHOLD = 3

/** Max SMS in flight (pending claim / dispatched) per device before it stops taking work. */
export const DEVICE_MAX_IN_FLIGHT = 5

/** Hard max age from requestedAt (or scheduled fire time). Older SMS are canceled, never sent. */
export const SMS_MAX_AGE_MS = 2 * 60 * 60 * 1000 // 2 hours

/** How long a device may hold a claimed (not yet dispatched) SMS before another device can steal it. */
export const SMS_LEASE_MS = 2 * 60 * 1000 // 2 minutes

/**
 * Lease applied once the command is actually handed to a device (FCM accepted or
 * pulled via claim-outbox). It must be long enough for the handset to reach the
 * modem and report back, otherwise lease reclaim re-sends messages that are
 * still in flight.
 */
export const SMS_DISPATCH_LEASE_MS = 10 * 60 * 1000 // 10 minutes

/** Max dispatch/send attempts across devices (includes first try). */
export const SMS_MAX_ATTEMPTS = 5

/** Heartbeat must be newer than this for a device to be preferred as "online". */
export const DEVICE_ONLINE_HEARTBEAT_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Active outbound statuses (protected from history deletion, block resends).
 * Device capacity is NOT "every pending row assigned to the device": see
 * SmsOutboxService.getInFlightCount, which only counts work the handset holds.
 */
export const DEVICE_IN_FLIGHT_STATUSES = ['pending', 'dispatched'] as const

/** Lifetime of a `work_available` wake-up push; stale wake-ups are useless. */
export const WORK_AVAILABLE_TTL_MS = 2 * 60 * 1000 // 2 minutes

/**
 * Backoff before an SMS is retried on the handset that just failed it, used
 * only when no other device can take it. Doubles per attempt up to the cap.
 */
export const SMS_RETRY_BASE_DELAY_MS = 60 * 1000 // 1 minute
export const SMS_RETRY_MAX_DELAY_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Device-reported failures that retrying on the same handset cannot fix
 * (missing permission, bad recipient, FDN/short-code carrier blocks).
 */
export const NON_RETRYABLE_DEVICE_ERRORS = [
  'PERMISSION_DENIED',
  'INVALID_RECIPIENT',
  '6', // SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE
  '7', // SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED
  '8', // SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED
] as const

export const SMS_REASON_RETRY_SCHEDULED = 'RETRY_SCHEDULED'
export const SMS_REASON_RETRY_BACKOFF = 'RETRY_BACKOFF'

/** Statuses that count toward failure cooldown. */
export const DEVICE_FAILED_SEND_STATUSES = ['failed', 'unknown'] as const

/** Active statuses that block duplicate resend of the same logical message. */
export const RESENDABLE_BLOCKED_STATUSES = ['pending', 'dispatched'] as const

export const SMS_ERROR_EXPIRED = 'EXPIRED_MAX_AGE'
export const SMS_ERROR_MAX_ATTEMPTS = 'MAX_ATTEMPTS_EXCEEDED'
export const SMS_ERROR_NO_DEVICE = 'NO_ELIGIBLE_DEVICE'
