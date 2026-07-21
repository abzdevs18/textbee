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

/** How long a device may hold a claimed SMS before another device can steal it. */
export const SMS_LEASE_MS = 2 * 60 * 1000 // 2 minutes

/** Max dispatch/send attempts across devices (includes first try). */
export const SMS_MAX_ATTEMPTS = 5

/** Heartbeat must be newer than this for a device to be preferred as "online". */
export const DEVICE_ONLINE_HEARTBEAT_MS = 30 * 60 * 1000 // 30 minutes

/** Statuses that count as holding device capacity. */
export const DEVICE_IN_FLIGHT_STATUSES = ['pending', 'dispatched'] as const

/** Statuses that count toward failure cooldown. */
export const DEVICE_FAILED_SEND_STATUSES = ['failed', 'unknown'] as const

/** Active statuses that block duplicate resend of the same logical message. */
export const RESENDABLE_BLOCKED_STATUSES = ['pending', 'dispatched'] as const

export const SMS_ERROR_EXPIRED = 'EXPIRED_MAX_AGE'
export const SMS_ERROR_MAX_ATTEMPTS = 'MAX_ATTEMPTS_EXCEEDED'
export const SMS_ERROR_NO_DEVICE = 'NO_ELIGIBLE_DEVICE'
