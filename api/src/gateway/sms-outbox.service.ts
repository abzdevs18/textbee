import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import * as firebaseAdmin from 'firebase-admin'
import { Message } from 'firebase-admin/messaging'
import { Device, DeviceDocument } from './schemas/device.schema'
import { SMS } from './schemas/sms.schema'
import { SMSBatch } from './schemas/sms-batch.schema'
import { SMSType } from './sms-type.enum'
import { WebhookService } from '../webhook/webhook.service'
import { WebhookEvent } from '../webhook/webhook-event.enum'
import {
  DEVICE_FAILURE_COOLDOWN_MINUTES,
  DEVICE_FAILURE_THRESHOLD,
  DEVICE_FAILED_SEND_STATUSES,
  DEVICE_MAX_IN_FLIGHT,
  DEVICE_ONLINE_HEARTBEAT_MS,
  NON_RETRYABLE_DEVICE_ERRORS,
  SMS_ERROR_EXPIRED,
  SMS_ERROR_MAX_ATTEMPTS,
  SMS_ERROR_NO_DEVICE,
  SMS_DISPATCH_LEASE_MS,
  SMS_LEASE_MS,
  SMS_MAX_AGE_MS,
  SMS_MAX_ATTEMPTS,
  SMS_REASON_RETRY_BACKOFF,
  SMS_REASON_RETRY_SCHEDULED,
  SMS_RETRY_BASE_DELAY_MS,
  SMS_RETRY_MAX_DELAY_MS,
  WORK_AVAILABLE_TTL_MS,
} from './sms-delivery.constants'

export type DispatchResult = {
  smsId: string
  status: 'dispatched' | 'pending' | 'canceled' | 'failed'
  deviceId?: string
  reason?: string
}

type DeviceSelectionOptions = {
  /** Require a usable FCM token (push dispatch). Pull claims do not need one. */
  requirePushable?: boolean
  /** Skip in-flight and failure-cooldown checks (existence/assignment only). */
  ignoreLoad?: boolean
  requireFreshHeartbeat?: boolean
}

/** Mongo clause: not waiting out a retry backoff. */
function retryWindowOpen(now: Date): Record<string, unknown> {
  return {
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  }
}

function getFcmErrorCode(error: { code?: string; message?: string } | null): string {
  if (!error?.code) return 'FCM_DELIVERY_FAILED'
  const code = String(error.code).toLowerCase().replace(/^messaging\//, '')
  if (code === 'app/no-app') return 'FCM_FIREBASE_ADMIN_NOT_CONFIGURED'
  if (code === 'app/invalid-credential') return 'FCM_FIREBASE_ADMIN_INVALID_CREDENTIAL'
  if (code === 'registration-token-not-registered' || code === 'unregistered') {
    return 'FCM_TOKEN_NOT_REGISTERED'
  }
  if (code === 'invalid-registration-token') {
    return 'FCM_INVALID_REGISTRATION_TOKEN'
  }
  if (code === 'invalid-argument') {
    // invalid-argument also covers payload problems (e.g. message too big);
    // only blame the device token when Firebase says the token is the issue.
    return /registration token/i.test(String(error.message || ''))
      ? 'FCM_INVALID_REGISTRATION_TOKEN'
      : 'FCM_INVALID_ARGUMENT'
  }
  if (code === 'mismatched-credential') return 'FCM_PROJECT_MISMATCH'
  return `FCM_DELIVERY_FAILED_${error.code}`
}

function isRetryableDeviceFailure(errorCode?: string): boolean {
  if (!errorCode) return true
  if (errorCode === SMS_ERROR_EXPIRED) return false
  return !(NON_RETRYABLE_DEVICE_ERRORS as readonly string[]).includes(
    String(errorCode).trim().toUpperCase(),
  )
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1)
  return Math.min(SMS_RETRY_MAX_DELAY_MS, SMS_RETRY_BASE_DELAY_MS * 2 ** exponent)
}

function sendDelayMsOf(device: any): number {
  const seconds = Number(device?.smsSendDelaySeconds)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 0
}

/**
 * Dispatch lease for a handset. It must outlast the phone's own pacing (the
 * configured delay between sends), otherwise the lease expires while the SMS
 * is still queued on the phone and another attempt is started.
 */
export function dispatchLeaseMsFor(device: any): number {
  return Math.max(SMS_DISPATCH_LEASE_MS, 2 * sendDelayMsOf(device))
}

/** Commands a handset may hold at once so its paced queue drains well inside the lease. */
export function maxInFlightFor(device: any): number {
  const delayMs = sendDelayMsOf(device)
  if (delayMs <= 0) return DEVICE_MAX_IN_FLIGHT
  const fit = Math.floor(dispatchLeaseMsFor(device) / (2 * delayMs))
  return Math.min(DEVICE_MAX_IN_FLIGHT, Math.max(1, fit))
}

function normalizeAssignedTenantTag(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const tag = value.trim().toLowerCase()
  return tag || null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getFcmErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  const code = String(error?.code || '').toLowerCase()
  if (code === 'app/no-app') {
    return 'Firebase Admin is not initialized on the API server.'
  }
  if (code === 'app/invalid-credential') {
    return 'Firebase Admin credentials are invalid.'
  }
  return error?.message || 'FCM delivery failed'
}

@Injectable()
export class SmsOutboxService {
  private readonly logger = new Logger(SmsOutboxService.name)

  constructor(
    @InjectModel(Device.name) private deviceModel: Model<DeviceDocument>,
    @InjectModel(SMS.name) private smsModel: Model<SMS>,
    @InjectModel(SMSBatch.name) private smsBatchModel: Model<SMSBatch>,
    private webhookService: WebhookService,
  ) {}

  computeExpiresAt(requestedAt: Date, scheduledAt?: Date | null): Date {
    const base =
      scheduledAt && scheduledAt.getTime() > requestedAt.getTime()
        ? scheduledAt
        : requestedAt
    return new Date(base.getTime() + SMS_MAX_AGE_MS)
  }

  isExpired(sms: { expiresAt?: Date | null; requestedAt?: Date | null; scheduledAt?: Date | null }): boolean {
    const expiresAt =
      sms.expiresAt ||
      this.computeExpiresAt(
        sms.requestedAt ? new Date(sms.requestedAt) : new Date(),
        sms.scheduledAt ? new Date(sms.scheduledAt) : null,
      )
    return Date.now() >= new Date(expiresAt).getTime()
  }

  private resolveExpiresAt(sms: any): Date {
    return sms.expiresAt
      ? new Date(sms.expiresAt)
      : this.computeExpiresAt(
          sms.requestedAt ? new Date(sms.requestedAt) : new Date(),
          sms.scheduledAt ? new Date(sms.scheduledAt) : null,
        )
  }

  /**
   * Command shape the handset executes, shared by FCM push and claim-outbox.
   * `attempt` lets the phone tell a deliberate server retry from a duplicate
   * delivery of the same attempt; `issuedAt` (server clock) lets it judge
   * expiry without trusting its own wall clock.
   */
  buildDevicePayload(
    sms: any,
    device: any,
    issuedAt: Date = new Date(),
    leaseUntil?: Date | null,
  ) {
    const lease =
      leaseUntil && !Number.isNaN(new Date(leaseUntil).getTime())
        ? new Date(leaseUntil)
        : new Date(issuedAt.getTime() + dispatchLeaseMsFor(device))
    return {
      smsId: sms._id.toString(),
      smsBatchId: sms.smsBatch?.toString?.() || sms.smsBatch,
      deviceId: device._id.toString(),
      targetDeviceId: device._id.toString(),
      message: sms.message,
      recipients: [sms.recipient],
      expiresAt: this.resolveExpiresAt(sms).toISOString(),
      issuedAt: issuedAt.toISOString(),
      // After this the outbox may give the SMS to another phone, so the
      // handset must not *start* sending it later (it waits for a re-issue).
      leaseUntil: lease.toISOString(),
      attempt: Math.max(1, Number(sms.attemptCount) || 1),
      ...(sms.simSubscriptionId !== undefined &&
        sms.simSubscriptionId !== null && {
          simSubscriptionId: sms.simSubscriptionId,
        }),
      smsBody: sms.message,
      receivers: [sms.recipient],
    }
  }

  buildFcmMessage(sms: any, device: any): Message {
    const issuedAt = new Date()
    const payload = this.buildDevicePayload(sms, device, issuedAt)
    const remainingMs = this.resolveExpiresAt(sms).getTime() - issuedAt.getTime()
    // An undelivered command must not surface hours later (FCM default TTL is
    // 4 weeks): after the dispatch lease the outbox re-dispatches or the
    // phone pulls it, so a late copy could only produce a duplicate send.
    const ttl = Math.max(1000, Math.min(dispatchLeaseMsFor(device), remainingMs))

    return {
      data: {
        smsData: JSON.stringify(payload),
        targetDeviceId: device._id.toString(),
      },
      token: device.fcmToken,
      android: {
        priority: 'high' as const,
        ttl,
      },
    }
  }

  /**
   * Work the handset actually holds: commands handed over and not yet
   * reported (dispatched with a live lease) plus SMS mid-claim. Pending rows
   * merely *assigned* to the device do not count — counting them let 5+
   * waiting rows lock the phone out of both push dispatch and pull claims.
   */
  private async getInFlightCount(deviceId: string, userId: any): Promise<number> {
    const now = new Date()
    return this.smsModel.countDocuments({
      user: userId,
      device: deviceId,
      type: SMSType.SENT,
      $or: [
        { status: 'dispatched', leasedUntil: { $gt: now } },
        {
          // Legacy rows dispatched before leases existed.
          status: 'dispatched',
          leasedUntil: null,
          dispatchedAt: { $gt: new Date(now.getTime() - SMS_DISPATCH_LEASE_MS) },
        },
        { status: 'pending', leasedUntil: { $gt: now } },
      ],
    })
  }

  private async getRecentFailureCount(deviceId: string, userId: any): Promise<number> {
    const since = new Date(Date.now() - DEVICE_FAILURE_COOLDOWN_MINUTES * 60 * 1000)
    return this.smsModel.countDocuments({
      user: userId,
      device: deviceId,
      type: SMSType.SENT,
      status: { $in: [...DEVICE_FAILED_SEND_STATUSES] },
      $or: [
        { failedAt: { $gte: since } },
        { updatedAt: { $gte: since } },
        { createdAt: { $gte: since } },
      ],
    })
  }

  async isDeviceEligible(
    device: any,
    userId: any,
    opts: DeviceSelectionOptions = {},
  ): Promise<{ eligible: boolean; reason?: string }> {
    const requirePushable = opts.requirePushable !== false
    if (!device?.enabled) {
      return { eligible: false, reason: 'Device disabled' }
    }
    if (requirePushable && !device.fcmToken) {
      return { eligible: false, reason: 'Missing FCM token' }
    }
    if (requirePushable && device.fcmTokenInvalidatedAt) {
      return { eligible: false, reason: 'FCM token invalidated' }
    }

    if (opts.requireFreshHeartbeat) {
      const last = device.lastHeartbeat ? new Date(device.lastHeartbeat).getTime() : 0
      if (!last || Date.now() - last > DEVICE_ONLINE_HEARTBEAT_MS) {
        return { eligible: false, reason: 'Stale heartbeat' }
      }
    }

    if (opts.ignoreLoad) {
      return { eligible: true }
    }

    const inFlight = await this.getInFlightCount(device._id.toString(), userId)
    const cap = maxInFlightFor(device)
    if (inFlight >= cap) {
      return {
        eligible: false,
        reason: `In-flight cap reached (${inFlight}/${cap})`,
      }
    }

    const failures = await this.getRecentFailureCount(device._id.toString(), userId)
    if (failures >= DEVICE_FAILURE_THRESHOLD) {
      return {
        eligible: false,
        reason: `Failure cooldown (${failures} fails in ${DEVICE_FAILURE_COOLDOWN_MINUTES}m)`,
      }
    }

    return { eligible: true }
  }

  private sameAssignmentFilter(tag: string | null): Record<string, unknown> {
    if (tag) {
      return {
        assignedTenantTag: { $regex: new RegExp(`^${escapeRegex(tag)}$`, 'i') },
      }
    }

    return {
      $or: [
        { assignedTenantTag: { $exists: false } },
        { assignedTenantTag: null },
        { assignedTenantTag: '' },
      ],
    }
  }

  private async deviceIdsWithSameAssignment(
    userId: any,
    tag: string | null,
  ): Promise<Types.ObjectId[]> {
    const rows = await this.deviceModel.find({
      user: userId,
      ...this.sameAssignmentFilter(tag),
    })
    return rows.map((row) => row._id)
  }

  private async assignedTenantTagsForUser(userId: any): Promise<string[]> {
    const rows = await this.deviceModel.find({
      user: userId,
      assignedTenantTag: { $exists: true, $nin: [null, ''] },
    })
    return Array.from(new Set(
      rows
        .map((row) => normalizeAssignedTenantTag(row.assignedTenantTag))
        .filter((tag): tag is string => Boolean(tag)),
    ))
  }

  /**
   * Rank free devices for a user. Preferred device first if eligible.
   * Dedicated phones only share work with the same school assignment.
   */
  async listEligibleDevices(
    userId: any,
    opts: DeviceSelectionOptions & {
      preferredDeviceId?: string
      /** Immutable SMS tenant affinity. Shared devices remain valid fallbacks. */
      tenantTag?: string
      excludeDeviceIds?: string[]
    } = {},
  ): Promise<any[]> {
    const exclude = new Set((opts.excludeDeviceIds || []).map(String))
    const requirePushable = opts.requirePushable !== false
    const devices = await this.deviceModel.find({
      user: userId,
      enabled: true,
      ...(requirePushable && {
        fcmToken: { $exists: true, $nin: [null, ''] },
        $or: [
          { fcmTokenInvalidatedAt: null },
          { fcmTokenInvalidatedAt: { $exists: false } },
        ],
      }),
    })

    const messageTenantTag = normalizeAssignedTenantTag(opts.tenantTag)
    const hasDedicatedDeviceForMessage = Boolean(
      messageTenantTag && devices.some(
        (device) => normalizeAssignedTenantTag(device.assignedTenantTag) === messageTenantTag,
      ),
    )
    let requiredAssignmentTag: string | null | undefined = messageTenantTag || undefined
    if (!messageTenantTag && opts.preferredDeviceId) {
      const preferred =
        devices.find((device) => String(device._id) === String(opts.preferredDeviceId)) ||
        (await this.deviceModel.findById(opts.preferredDeviceId))
      requiredAssignmentTag = preferred
        ? normalizeAssignedTenantTag(preferred.assignedTenantTag)
        : undefined
    }

    const scored: Array<{ device: any; score: number }> = []
    for (const device of devices) {
      const id = device._id.toString()
      if (exclude.has(id)) continue
      const deviceTenantTag = normalizeAssignedTenantTag(device.assignedTenantTag)
      if (
        requiredAssignmentTag !== undefined &&
        deviceTenantTag !== requiredAssignmentTag &&
        // An unassigned phone is an intentional shared-pool worker. It can
        // deliver a tagged message but can never redefine that message's tag.
        !(messageTenantTag && !hasDedicatedDeviceForMessage && deviceTenantTag === null)
      ) {
        continue
      }

      const check = await this.isDeviceEligible(device, userId, {
        requireFreshHeartbeat: opts.requireFreshHeartbeat,
        requirePushable,
        ignoreLoad: opts.ignoreLoad,
      })
      if (!check.eligible) continue

      const inFlight = opts.ignoreLoad ? 0 : await this.getInFlightCount(id, userId)
      const failures = opts.ignoreLoad ? 0 : await this.getRecentFailureCount(id, userId)
      const heartbeatAge = device.lastHeartbeat
        ? Date.now() - new Date(device.lastHeartbeat).getTime()
        : Number.MAX_SAFE_INTEGER

      let score = inFlight * 100 + failures * 50 + Math.min(heartbeatAge / 60000, 1000)
      if (opts.preferredDeviceId && id === String(opts.preferredDeviceId)) {
        score -= 10_000 // strong preference
      }
      scored.push({ device, score })
    }

    scored.sort((a, b) => a.score - b.score)
    return scored.map((s) => s.device)
  }

  async cancelExpiredSms(sms: any, reason = 'SMS exceeded max pending age (2 hours)'): Promise<any> {
    const now = new Date()
    const updated = await this.smsModel.findOneAndUpdate(
      {
        _id: sms._id,
        status: { $in: ['pending', 'dispatched'] },
      },
      {
        $set: {
          status: 'canceled',
          canceledAt: now,
          errorCode: SMS_ERROR_EXPIRED,
          errorMessage: reason,
          'metadata.expiredAt': now,
        },
        $unset: {
          leasedUntil: '',
          leasedAt: '',
          queueJobId: '',
        },
      },
      { new: true },
    )
    return updated
  }

  /**
   * Cancel all outbound SMS past expiresAt that are still pending/dispatched.
   */
  async cancelAllExpired(): Promise<number> {
    const now = new Date()
    const result = await this.smsModel.updateMany(
      {
        type: SMSType.SENT,
        status: { $in: ['pending', 'dispatched'] },
        $or: [
          { expiresAt: { $lte: now } },
          {
            expiresAt: { $exists: false },
            requestedAt: { $lte: new Date(now.getTime() - SMS_MAX_AGE_MS) },
          },
        ],
      },
      {
        $set: {
          status: 'canceled',
          canceledAt: now,
          errorCode: SMS_ERROR_EXPIRED,
          errorMessage: 'SMS exceeded max pending age (2 hours) and was canceled',
          'metadata.expiredAt': now,
        },
        $unset: {
          leasedUntil: '',
          leasedAt: '',
          queueJobId: '',
        },
      },
    )
    return (result as any).modifiedCount || 0
  }

  /**
   * Release stale leases so SMS can be claimed by another free device.
   */
  async reclaimExpiredLeases(): Promise<number> {
    const now = new Date()
    const result = await this.smsModel.updateMany(
      {
        type: SMSType.SENT,
        status: { $in: ['pending', 'dispatched'] },
        leasedUntil: { $lte: now },
      },
      {
        $set: {
          status: 'pending',
        },
        $unset: {
          leasedUntil: '',
          leasedAt: '',
          queueJobId: '',
          dispatchedAt: '',
        },
      },
    )
    return (result as any).modifiedCount || 0
  }

  private async markFailed(
    smsId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<any> {
    const now = new Date()
    return this.smsModel.findByIdAndUpdate(
      smsId,
      {
        $set: {
          status: 'failed',
          failedAt: now,
          errorCode,
          errorMessage,
        },
        $unset: {
          leasedUntil: '',
          leasedAt: '',
          queueJobId: '',
        },
      },
      { new: true },
    )
  }

  private async releaseToPending(
    smsId: string,
    extra: Record<string, any> = {},
  ): Promise<any> {
    const unset: Record<string, ''> = {
      leasedUntil: '',
      leasedAt: '',
      queueJobId: '',
      dispatchedAt: '',
      errorCode: '',
      errorMessage: '',
    }
    // MongoDB rejects an update that $sets and $unsets the same path
    // ("would create a conflict"). The NO_ELIGIBLE_DEVICE path passes
    // errorCode/errorMessage, and that rejection used to abort sendSMS (500
    // after the rows were created) and the whole outbox maintenance cron.
    for (const key of Object.keys(extra)) {
      delete unset[key]
    }
    return this.smsModel.findByIdAndUpdate(
      smsId,
      {
        $set: {
          status: 'pending',
          ...extra,
        },
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
      },
      { new: true },
    )
  }

  /**
   * FCM could not hand the command to this device. That says nothing about the
   * handset's ability to send, so keep the row claimable — by another device's
   * push or by this device's own claim-outbox pull — and give the attempt
   * back, since nothing reached a handset. (Excluding the device here used to
   * strand the SMS on single-phone setups: its pull path skipped it forever.)
   */
  private async releaseAfterPushFailure(
    smsId: string,
    deviceId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.smsModel.findOneAndUpdate(
      { _id: smsId, status: 'pending', attemptCount: { $gt: 0 } },
      {
        $set: {
          status: 'pending',
          errorCode,
          errorMessage,
          'metadata.lastPushFailure': { at: new Date(), deviceId, errorCode },
        },
        $inc: { attemptCount: -1 },
        $unset: {
          leasedUntil: '',
          leasedAt: '',
          dispatchedAt: '',
        },
      },
    )
  }

  /**
   * Try to assign the best free device and FCM-push this SMS immediately.
   * Walks eligible devices until one accepts or attempts are exhausted.
   */
  async tryDispatchSms(
    smsId: string,
    opts: { excludeDeviceIds?: string[] } = {},
  ): Promise<DispatchResult> {
    const sms = await this.smsModel.findById(smsId)
    if (!sms) {
      return { smsId, status: 'failed', reason: 'SMS not found' }
    }

    if (sms.type !== SMSType.SENT) {
      return { smsId, status: 'failed', reason: 'Not an outbound SMS' }
    }

    if (['sent', 'delivered', 'canceled'].includes(String(sms.status).toLowerCase())) {
      return { smsId, status: sms.status as any, reason: 'Already terminal' }
    }

    // Ensure expiresAt exists (legacy rows)
    if (!sms.expiresAt) {
      const expiresAt = this.computeExpiresAt(
        sms.requestedAt ? new Date(sms.requestedAt) : new Date((sms as any).createdAt || Date.now()),
        sms.scheduledAt ? new Date(sms.scheduledAt) : null,
      )
      sms.expiresAt = expiresAt
      await this.smsModel.updateOne({ _id: sms._id }, { $set: { expiresAt } })
    }

    if (this.isExpired(sms)) {
      await this.cancelExpiredSms(sms)
      return { smsId, status: 'canceled', reason: SMS_ERROR_EXPIRED }
    }

    // Respect future schedule
    if (sms.scheduledAt && new Date(sms.scheduledAt).getTime() > Date.now()) {
      return { smsId, status: 'pending', reason: 'Scheduled for future' }
    }

    // Respect a retry backoff set after a handset failure
    if (sms.nextAttemptAt && new Date(sms.nextAttemptAt).getTime() > Date.now()) {
      return { smsId, status: 'pending', reason: SMS_REASON_RETRY_BACKOFF }
    }

    const maxAttempts = sms.maxAttempts || SMS_MAX_ATTEMPTS
    const attemptCount = sms.attemptCount || 0
    if (attemptCount >= maxAttempts) {
      await this.markFailed(
        smsId,
        SMS_ERROR_MAX_ATTEMPTS,
        `Exhausted ${maxAttempts} send attempts across devices`,
      )
      return { smsId, status: 'failed', reason: SMS_ERROR_MAX_ATTEMPTS }
    }

    const userId = (sms.user as any)?._id || sms.user
    const excluded = [
      ...(opts.excludeDeviceIds || []),
      ...((sms.excludedDeviceIds || []).map((id: any) => id.toString())),
    ]

    const preferredId =
      sms.preferredDevice?.toString?.() ||
      sms.device?.toString?.() ||
      undefined
    const immutableTenantTag = normalizeAssignedTenantTag(sms.tenantTag)

    // Prefer online devices first; if none, fall back without heartbeat requirement
    let candidates = await this.listEligibleDevices(userId, {
      preferredDeviceId: preferredId,
      ...(immutableTenantTag ? { tenantTag: immutableTenantTag } : {}),
      excludeDeviceIds: excluded,
      requireFreshHeartbeat: true,
    })
    if (candidates.length === 0) {
      candidates = await this.listEligibleDevices(userId, {
        preferredDeviceId: preferredId,
        ...(immutableTenantTag ? { tenantTag: immutableTenantTag } : {}),
        excludeDeviceIds: excluded,
        requireFreshHeartbeat: false,
      })
    }

    if (candidates.length === 0) {
      // Leave pending for later claim when a device frees up
      await this.releaseToPending(smsId, {
        errorCode: SMS_ERROR_NO_DEVICE,
        errorMessage: 'Waiting for a free eligible device',
      })
      await this.notifyWorkAvailable(userId)
      return { smsId, status: 'pending', reason: SMS_ERROR_NO_DEVICE }
    }

    for (const device of candidates) {
      const deviceId = device._id.toString()
      const now = new Date()
      const leaseUntil = new Date(now.getTime() + SMS_LEASE_MS)

      // Atomic claim — only if still pending/dispatched-with-expired-lease and not expired
      const claimed = await this.smsModel.findOneAndUpdate(
        {
          _id: sms._id,
          type: SMSType.SENT,
          status: { $in: ['pending', 'dispatched'] },
          expiresAt: { $gt: now },
          $and: [
            {
              $or: [
                { leasedUntil: null },
                { leasedUntil: { $exists: false } },
                { leasedUntil: { $lte: now } },
              ],
            },
            retryWindowOpen(now),
          ],
          $expr: {
            $lt: [{ $ifNull: ['$attemptCount', 0] }, { $ifNull: ['$maxAttempts', SMS_MAX_ATTEMPTS] }],
          },
        },
        {
          $set: {
            device: device._id,
            status: 'pending',
            leasedAt: now,
            leasedUntil: leaseUntil,
            errorCode: null,
            errorMessage: null,
          },
          $unset: { nextAttemptAt: '' },
          $inc: { attemptCount: 1 },
          $push: {
            'metadata.dispatchAttempts': {
              at: now,
              deviceId,
              via: 'push',
            },
          },
        },
        { new: true },
      )

      if (!claimed) {
        // Someone else claimed it or status changed
        const current = await this.smsModel.findById(smsId)
        if (!current || ['sent', 'delivered', 'canceled', 'failed'].includes(String(current.status))) {
          return {
            smsId,
            status: (current?.status as any) || 'failed',
            reason: 'Claim lost',
          }
        }
        continue
      }

      try {
        const fcmMessage = this.buildFcmMessage(claimed, device)
        const response = await firebaseAdmin.messaging().sendEach([fcmMessage])
        const first = response.responses[0]

        if (first?.success) {
          const dispatchedAt = new Date()
          await this.smsModel.findByIdAndUpdate(smsId, {
            $set: {
              status: 'dispatched',
              dispatchedAt,
              device: device._id,
              // Hold the lease for the full handset deadline. Without this the
              // 2-minute claim lease expires while the SMS is still in flight
              // and the maintenance cron re-dispatches it (duplicate sends and
              // a permanently refreshed dispatchedAt).
              leasedAt: dispatchedAt,
              leasedUntil: new Date(dispatchedAt.getTime() + dispatchLeaseMsFor(device)),
            },
          })
          this.deviceModel
            .findByIdAndUpdate(deviceId, { $inc: { sentSMSCount: 1 } })
            .exec()
            .catch(() => undefined)

          return { smsId, status: 'dispatched', deviceId }
        }

        const errCode = getFcmErrorCode(first?.error ?? null)
        const errMsg = getFcmErrorMessage(first?.error)
        this.logger.warn(`FCM failed for SMS ${smsId} on device ${deviceId}: ${errCode}`)

        // Permanent token errors — stop pushing to this token until the
        // handset re-registers or re-asserts it (heartbeat/update).
        if (
          errCode === 'FCM_TOKEN_NOT_REGISTERED' ||
          errCode === 'FCM_INVALID_REGISTRATION_TOKEN'
        ) {
          await this.deviceModel.findByIdAndUpdate(deviceId, {
            $set: {
              fcmTokenInvalidatedAt: new Date(),
              fcmTokenInvalidReason: errCode,
            },
          })
        }

        await this.releaseAfterPushFailure(smsId, deviceId, errCode, errMsg)
      } catch (error: any) {
        this.logger.error(`Dispatch exception for SMS ${smsId}`, error?.stack || error?.message)
        await this.releaseAfterPushFailure(
          smsId,
          deviceId,
          getFcmErrorCode(error),
          getFcmErrorMessage(error),
        )
      }
    }

    // All candidates tried this round
    const refreshed = await this.smsModel.findById(smsId)
    const attempts = refreshed?.attemptCount || 0
    const max = refreshed?.maxAttempts || SMS_MAX_ATTEMPTS
    if (attempts >= max) {
      await this.markFailed(
        smsId,
        SMS_ERROR_MAX_ATTEMPTS,
        `Exhausted ${max} send attempts across devices`,
      )
      const failedSms = await this.smsModel.findById(smsId)
      if (failedSms) {
        this.webhookService
          .deliverNotification({
            sms: failedSms,
            user: userId,
            event: WebhookEvent.MESSAGE_FAILED,
          })
          .catch(() => undefined)
      }
      return { smsId, status: 'failed', reason: SMS_ERROR_MAX_ATTEMPTS }
    }

    await this.notifyWorkAvailable(userId)
    return { smsId, status: 'pending', reason: 'Waiting for free device after failed attempts' }
  }

  async dispatchMany(smsIds: string[]): Promise<DispatchResult[]> {
    const results: DispatchResult[] = []
    for (const smsId of smsIds) {
      try {
        results.push(await this.tryDispatchSms(smsId))
      } catch (e: any) {
        // The row is already in the outbox; the maintenance cron and device
        // pulls will deliver it. Failing the request here made callers retry
        // and create duplicate SMS rows.
        this.logger.warn(`Immediate dispatch deferred for SMS ${smsId}: ${e?.message}`)
        results.push({ smsId, status: 'pending', reason: 'DISPATCH_DEFERRED' })
      }
    }
    return results
  }

  /**
   * After carrier/device reports failure — requeue to another free device ASAP.
   */
  async handleSendFailureAndFailover(
    smsId: string,
    failedDeviceId: string,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<DispatchResult | null> {
    const sms = await this.smsModel.findById(smsId)
    if (!sms || sms.type !== SMSType.SENT) return null

    if (errorCode === SMS_ERROR_EXPIRED || this.isExpired(sms)) {
      await this.cancelExpiredSms(
        sms,
        errorMessage || 'SMS exceeded max pending age (2 hours)',
      )
      return { smsId, status: 'canceled', reason: SMS_ERROR_EXPIRED }
    }

    // Already handled and waiting out a retry backoff: a repeated report (one
    // FAILED per multipart part from older phones, or a retried report) must
    // not re-exclude the only phone that can send it.
    if (
      String(sms.status) === 'pending' &&
      sms.nextAttemptAt &&
      new Date(sms.nextAttemptAt).getTime() > Date.now()
    ) {
      return { smsId, status: 'pending', reason: SMS_REASON_RETRY_BACKOFF }
    }

    const maxAttempts = sms.maxAttempts || SMS_MAX_ATTEMPTS
    const attemptCount = sms.attemptCount || 0

    // Record failure on this device then try others
    await this.smsModel.findByIdAndUpdate(smsId, {
      $addToSet: {
        excludedDeviceIds: new Types.ObjectId(failedDeviceId),
      },
      $set: {
        status: 'pending',
        errorCode: errorCode || 'DEVICE_SEND_FAILED',
        errorMessage: errorMessage || 'Device reported send failure; requeuing',
        'metadata.lastDeviceFailure': {
          at: new Date(),
          deviceId: failedDeviceId,
          errorCode,
          errorMessage,
        },
      },
      $unset: {
        leasedUntil: '',
        leasedAt: '',
        dispatchedAt: '',
        queueJobId: '',
      },
    })

    if (attemptCount >= maxAttempts) {
      await this.markFailed(
        smsId,
        errorCode || SMS_ERROR_MAX_ATTEMPTS,
        errorMessage || `Exhausted ${maxAttempts} attempts`,
      )
      return { smsId, status: 'failed', reason: SMS_ERROR_MAX_ATTEMPTS }
    }

    // Immediate failover to next free device
    const result = await this.tryDispatchSms(smsId, {
      excludeDeviceIds: [failedDeviceId],
    })
    if (result.status !== 'pending' || result.reason !== SMS_ERROR_NO_DEVICE) {
      return result
    }

    // Nobody else can take it right now. If another *live* device exists
    // (busy, or reachable only by its pull loop), keep waiting for it. Rows of
    // phones that are off or were reinstalled never pull, so they don't count.
    const userId = (sms.user as any)?._id || sms.user
    const tenantTag = normalizeAssignedTenantTag(sms.tenantTag)
    const alternatives = await this.listEligibleDevices(userId, {
      preferredDeviceId:
        sms.preferredDevice?.toString?.() ||
        sms.device?.toString?.() ||
        failedDeviceId,
      ...(tenantTag ? { tenantTag } : {}),
      excludeDeviceIds: [
        failedDeviceId,
        ...((sms.excludedDeviceIds || []).map((id: any) => id.toString())),
      ],
      requirePushable: false,
      ignoreLoad: true,
      requireFreshHeartbeat: true,
    })
    if (alternatives.length > 0) {
      return result
    }

    if (isRetryableDeviceFailure(errorCode)) {
      // The handset that failed is the only one that can send this SMS. Retry
      // it there after a backoff; leaving it excluded kept it "pending" with
      // no possible sender until the 2-hour cancel.
      const delayMs = retryDelayMs(attemptCount)
      await this.smsModel.findByIdAndUpdate(smsId, {
        $pull: { excludedDeviceIds: new Types.ObjectId(failedDeviceId) },
        $set: {
          nextAttemptAt: new Date(Date.now() + delayMs),
          errorCode: errorCode || 'DEVICE_SEND_FAILED',
          errorMessage: `${errorMessage || 'Device reported send failure'} (retrying in ${Math.round(delayMs / 1000)}s)`,
        },
      })
      return {
        smsId,
        status: 'pending',
        deviceId: failedDeviceId,
        reason: SMS_REASON_RETRY_SCHEDULED,
      }
    }

    // Permanent failure and no other device: surface it instead of leaving a
    // row that looks pending but can never be sent.
    await this.markFailed(
      smsId,
      errorCode || 'DEVICE_SEND_FAILED',
      errorMessage || 'Device reported a permanent send failure',
    )
    return { smsId, status: 'failed', reason: errorCode || 'DEVICE_SEND_FAILED' }
  }

  /**
   * Device pull (claim-outbox): optionally re-deliver work this device already
   * holds, then atomically claim pending outbox SMS up to its free capacity.
   * Triggered by work_available pushes, heartbeats and the phone's poll loop.
   * A pull proves the handset is online, so FCM token health is irrelevant.
   */
  async claimForDevice(
    deviceId: string,
    limit = 5,
    opts: { resync?: boolean } = {},
  ): Promise<{ claimed: number; redelivered: number; messages: any[] }> {
    const device = await this.deviceModel.findById(deviceId)
    if (!device?.enabled) {
      return { claimed: 0, redelivered: 0, messages: [] }
    }

    const userId = device.user
    const now = new Date()
    const messages: any[] = []

    // A pull proves the phone is online: keep its liveness fresh for routing
    // (fresh-heartbeat preference, single-phone retry decisions, Gabay pools).
    this.deviceModel
      .findByIdAndUpdate(device._id, { $set: { lastHeartbeat: now } })
      .exec()
      .catch(() => undefined)

    // Firebase can accept a command that never reaches the app (process
    // killed, OEM battery manager, deprioritized push). Hand the phone its
    // still-leased work again so it is sent now rather than after the lease
    // expires. Only clients that dedupe by smsId+attempt send `resync`. The
    // payload carries the existing lease; it is not extended.
    let redelivered = 0
    if (opts.resync) {
      const held = await this.smsModel.find(
        {
          user: userId,
          device: device._id,
          type: SMSType.SENT,
          status: 'dispatched',
          leasedUntil: { $gt: now },
          expiresAt: { $gt: now },
        },
        null,
        { sort: { dispatchedAt: 1 }, limit: DEVICE_MAX_IN_FLIGHT * 4 },
      )
      for (const sms of held || []) {
        messages.push(this.buildDevicePayload(sms, device, now, sms.leasedUntil))
      }
      redelivered = messages.length
    }

    const eligibility = await this.isDeviceEligible(device, userId, {
      requireFreshHeartbeat: false,
      requirePushable: false,
    })
    if (!eligibility.eligible) {
      return { claimed: 0, redelivered, messages }
    }

    const inFlight = await this.getInFlightCount(device._id.toString(), userId)
    const capacity = Math.max(0, maxInFlightFor(device) - inFlight)
    const maxClaim = Math.min(Math.max(1, limit), capacity)
    let claimedCount = 0

    for (let i = 0; i < maxClaim; i++) {
      // Prefer SMS that prefer this device
      const claimed =
        (await this.atomicClaimOne(device, userId, now, true)) ||
        (await this.atomicClaimOne(device, userId, now, false))

      if (!claimed) break

      if (this.isExpired(claimed)) {
        await this.cancelExpiredSms(claimed)
        continue
      }

      // Device sends locally from claim response only (no FCM echo — avoids double send)
      try {
        const dispatchedAt = new Date()
        const leasedUntil = new Date(dispatchedAt.getTime() + dispatchLeaseMsFor(device))
        await this.smsModel.findByIdAndUpdate(claimed._id, {
          $set: {
            status: 'dispatched',
            dispatchedAt,
            device: device._id,
            leasedAt: dispatchedAt,
            leasedUntil,
          },
          // Lets updateSMSStatus accept this handset's report after a reassignment.
          $push: {
            'metadata.dispatchAttempts': {
              at: dispatchedAt,
              deviceId: device._id.toString(),
              via: 'claim',
            },
          },
        })

        messages.push(this.buildDevicePayload(claimed, device, dispatchedAt, leasedUntil))
        claimedCount++
      } catch (e: any) {
        this.logger.error(`claimForDevice processing failed: ${e?.message}`)
        await this.releaseToPending(claimed._id.toString())
      }
    }

    return { claimed: claimedCount, redelivered, messages }
  }

  private async atomicClaimOne(
    device: any,
    userId: any,
    now: Date,
    preferThisDevice: boolean,
  ): Promise<any | null> {
    const leaseUntil = new Date(now.getTime() + SMS_LEASE_MS)
    const filter: any = {
      user: userId,
      type: SMSType.SENT,
      status: 'pending',
      expiresAt: { $gt: now },
      $or: [
        { leasedUntil: null },
        { leasedUntil: { $exists: false } },
        { leasedUntil: { $lte: now } },
      ],
      $and: [
        {
          $or: [
            { scheduledAt: null },
            { scheduledAt: { $exists: false } },
            { scheduledAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { excludedDeviceIds: { $nin: [device._id] } },
            { excludedDeviceIds: { $exists: false } },
            { excludedDeviceIds: { $size: 0 } },
          ],
        },
        retryWindowOpen(now),
      ],
      $expr: {
        $lt: [{ $ifNull: ['$attemptCount', 0] }, { $ifNull: ['$maxAttempts', SMS_MAX_ATTEMPTS] }],
      },
    }

    const myTag = normalizeAssignedTenantTag(device.assignedTenantTag)
    const allowedIds = await this.deviceIdsWithSameAssignment(userId, myTag)
    const legacyAssignmentClause: Record<string, unknown>[] = [
      { preferredDevice: { $in: allowedIds } },
    ]
    if (!myTag) {
      legacyAssignmentClause.push(
        { preferredDevice: null },
        { preferredDevice: { $exists: false } },
      )
    }

    const assignedTenantTags = myTag
      ? []
      : await this.assignedTenantTagsForUser(userId)
    const immutableTenantClause: Record<string, unknown> = myTag
      ? { tenantTag: { $regex: new RegExp(`^${escapeRegex(myTag)}$`, 'i') } }
      : {
          // Shared phones may serve tenants that currently have no dedicated
          // worker, but must not steal work from an existing dedicated pool.
          tenantTag: {
            $exists: true,
            $nin: [null, '', ...assignedTenantTags],
          },
        }
    const legacyTenantClause = {
      $or: [
        { tenantTag: { $exists: false } },
        { tenantTag: null },
        { tenantTag: '' },
      ],
    }

    filter.$and.push({
      $or: [
        // New messages are claimed by their own immutable tenant tag. A
        // shared device may claim any tagged SMS; another school's dedicated
        // device cannot.
        immutableTenantClause,
        // Legacy rows have no tag, so preserve their old preferred-device
        // assignment behavior until they age out of the two-hour outbox.
        {
          $and: [
            legacyTenantClause,
            { $or: legacyAssignmentClause },
          ],
        },
      ],
    })

    if (preferThisDevice) {
      filter.$and.push({
        $or: [
          { preferredDevice: device._id },
          { device: device._id },
        ],
      })
    }

    return this.smsModel.findOneAndUpdate(
      filter,
      {
        $set: {
          device: device._id,
          leasedAt: now,
          leasedUntil: leaseUntil,
          status: 'pending',
        },
        $unset: { nextAttemptAt: '' },
        $inc: { attemptCount: 1 },
      },
      { new: true, sort: { requestedAt: 1 } },
    )
  }

  /**
   * Wake free devices so they claim from the outbox.
   */
  async notifyWorkAvailable(userId: any): Promise<void> {
    try {
      const devices = await this.listEligibleDevices(userId, {
        requireFreshHeartbeat: false,
      })
      if (devices.length === 0) return

      const messages: Message[] = devices
        .filter((d) => d.fcmToken)
        .slice(0, 20)
        .map((d) => ({
          data: {
            type: 'work_available',
          },
          token: d.fcmToken,
          android: {
            priority: 'high' as const,
            // Wake-ups are interchangeable: keep only the latest queued one
            // and drop it if the phone stays unreachable for long.
            collapseKey: 'work_available',
            ttl: WORK_AVAILABLE_TTL_MS,
          },
        }))

      if (messages.length === 0) return

      await firebaseAdmin.messaging().sendEach(messages)
    } catch (e: any) {
      this.logger.warn(`notifyWorkAvailable failed: ${e?.message}`)
    }
  }

  /** Outbound SMS that are unclaimed and sendable right now. */
  private waitingOutboxFilter(now: Date): Record<string, any> {
    return {
      type: SMSType.SENT,
      status: 'pending',
      expiresAt: { $gt: now },
      $or: [
        { leasedUntil: null },
        { leasedUntil: { $exists: false } },
        { leasedUntil: { $lte: now } },
      ],
      $and: [
        {
          $or: [
            { scheduledAt: null },
            { scheduledAt: { $exists: false } },
            { scheduledAt: { $lte: now } },
          ],
        },
        retryWindowOpen(now),
      ],
    }
  }

  /**
   * How much unclaimed, still-sendable work a user has waiting right now.
   */
  async countWaitingOutbox(userId: any): Promise<number> {
    return this.smsModel.countDocuments({
      user: userId,
      ...this.waitingOutboxFilter(new Date()),
    })
  }

  /**
   * Drain: dispatch waiting pending SMS globally (cron, heartbeat, status
   * reports). Rows that share a routing key with a row that just found no
   * eligible device are skipped for the rest of the run, so one dead school
   * phone at the head of the queue cannot starve everyone behind it.
   */
  async dispatchWaitingOutbox(limit = 50): Promise<number> {
    const now = new Date()
    const scanLimit = Math.min(500, Math.max(limit, limit * 5))
    const waiting = await this.smsModel
      .find(this.waitingOutboxFilter(now))
      .sort({ requestedAt: 1 })
      .limit(scanLimit)
      .select('_id user tenantTag preferredDevice device')
      .lean()

    let dispatched = 0
    let attempted = 0
    const blockedRoutes = new Set<string>()
    for (const row of waiting as any[]) {
      if (attempted >= limit) break
      const route = [
        String(row.user ?? ''),
        normalizeAssignedTenantTag(row.tenantTag) ?? '',
        String(row.preferredDevice ?? row.device ?? ''),
      ].join('|')
      if (blockedRoutes.has(route)) continue

      attempted++
      let result: DispatchResult
      try {
        result = await this.tryDispatchSms(row._id.toString())
      } catch (e: any) {
        // One bad row must not abort the drain for everyone else.
        this.logger.warn(`dispatchWaitingOutbox: SMS ${row._id} failed: ${e?.message}`)
        blockedRoutes.add(route)
        continue
      }
      if (result.status === 'dispatched') {
        dispatched++
      } else if (result.status === 'pending') {
        blockedRoutes.add(route)
      }
    }
    return dispatched
  }

  async getDeviceHealthSummary(deviceId: string, userId: any) {
    const inFlight = await this.getInFlightCount(deviceId, userId)
    const recentFailures = await this.getRecentFailureCount(deviceId, userId)
    return {
      inFlight,
      recentFailures,
      maxInFlight: DEVICE_MAX_IN_FLIGHT,
      failureThreshold: DEVICE_FAILURE_THRESHOLD,
      failureCooldownMinutes: DEVICE_FAILURE_COOLDOWN_MINUTES,
      isPaused:
        inFlight >= DEVICE_MAX_IN_FLIGHT ||
        recentFailures >= DEVICE_FAILURE_THRESHOLD,
    }
  }
}
