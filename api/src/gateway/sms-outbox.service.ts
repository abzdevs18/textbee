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
  DEVICE_IN_FLIGHT_STATUSES,
  DEVICE_MAX_IN_FLIGHT,
  DEVICE_ONLINE_HEARTBEAT_MS,
  SMS_ERROR_EXPIRED,
  SMS_ERROR_MAX_ATTEMPTS,
  SMS_ERROR_NO_DEVICE,
  SMS_DISPATCH_LEASE_MS,
  SMS_LEASE_MS,
  SMS_MAX_AGE_MS,
  SMS_MAX_ATTEMPTS,
} from './sms-delivery.constants'

export type DispatchResult = {
  smsId: string
  status: 'dispatched' | 'pending' | 'canceled' | 'failed'
  deviceId?: string
  reason?: string
}

function getFcmErrorCode(error: { code?: string; message?: string } | null): string {
  if (!error?.code) return 'FCM_DELIVERY_FAILED'
  const code = String(error.code).toLowerCase().replace(/^messaging\//, '')
  if (code === 'app/no-app') return 'FCM_FIREBASE_ADMIN_NOT_CONFIGURED'
  if (code === 'app/invalid-credential') return 'FCM_FIREBASE_ADMIN_INVALID_CREDENTIAL'
  if (code === 'registration-token-not-registered' || code === 'unregistered') {
    return 'FCM_TOKEN_NOT_REGISTERED'
  }
  if (code === 'invalid-registration-token' || code === 'invalid-argument') {
    return 'FCM_INVALID_REGISTRATION_TOKEN'
  }
  if (code === 'mismatched-credential') return 'FCM_PROJECT_MISMATCH'
  return `FCM_DELIVERY_FAILED_${error.code}`
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

  buildFcmMessage(sms: any, device: any): Message {
    const expiresAtIso = sms.expiresAt
      ? new Date(sms.expiresAt).toISOString()
      : this.computeExpiresAt(
          sms.requestedAt ? new Date(sms.requestedAt) : new Date(),
          sms.scheduledAt ? new Date(sms.scheduledAt) : null,
        ).toISOString()

    const payload = {
      smsId: sms._id.toString(),
      smsBatchId: sms.smsBatch?.toString?.() || sms.smsBatch,
      deviceId: device._id.toString(),
      targetDeviceId: device._id.toString(),
      message: sms.message,
      recipients: [sms.recipient],
      expiresAt: expiresAtIso,
      ...(sms.simSubscriptionId !== undefined && {
        simSubscriptionId: sms.simSubscriptionId,
      }),
      smsBody: sms.message,
      receivers: [sms.recipient],
    }

    return {
      data: {
        smsData: JSON.stringify(payload),
        targetDeviceId: device._id.toString(),
      },
      token: device.fcmToken,
      android: {
        priority: 'high' as const,
      },
    }
  }

  private async getInFlightCount(deviceId: string, userId: any): Promise<number> {
    return this.smsModel.countDocuments({
      user: userId,
      device: deviceId,
      type: SMSType.SENT,
      status: { $in: [...DEVICE_IN_FLIGHT_STATUSES] },
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
    opts: { requireFreshHeartbeat?: boolean } = {},
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (!device?.enabled) {
      return { eligible: false, reason: 'Device disabled' }
    }
    if (!device.fcmToken) {
      return { eligible: false, reason: 'Missing FCM token' }
    }
    if (device.fcmTokenInvalidatedAt) {
      return { eligible: false, reason: 'FCM token invalidated' }
    }

    if (opts.requireFreshHeartbeat) {
      const last = device.lastHeartbeat ? new Date(device.lastHeartbeat).getTime() : 0
      if (!last || Date.now() - last > DEVICE_ONLINE_HEARTBEAT_MS) {
        return { eligible: false, reason: 'Stale heartbeat' }
      }
    }

    const inFlight = await this.getInFlightCount(device._id.toString(), userId)
    if (inFlight >= DEVICE_MAX_IN_FLIGHT) {
      return {
        eligible: false,
        reason: `In-flight cap reached (${inFlight}/${DEVICE_MAX_IN_FLIGHT})`,
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

  /**
   * Rank free devices for a user. Preferred device first if eligible.
   * Dedicated phones only share work with the same school assignment.
   */
  async listEligibleDevices(
    userId: any,
    opts: {
      preferredDeviceId?: string
      excludeDeviceIds?: string[]
      requireFreshHeartbeat?: boolean
    } = {},
  ): Promise<any[]> {
    const exclude = new Set((opts.excludeDeviceIds || []).map(String))
    const devices = await this.deviceModel.find({
      user: userId,
      enabled: true,
      fcmToken: { $exists: true, $nin: [null, ''] },
      $or: [
        { fcmTokenInvalidatedAt: null },
        { fcmTokenInvalidatedAt: { $exists: false } },
      ],
    })

    let requiredAssignmentTag: string | null | undefined
    if (opts.preferredDeviceId) {
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
      if (
        requiredAssignmentTag !== undefined &&
        normalizeAssignedTenantTag(device.assignedTenantTag) !== requiredAssignmentTag
      ) {
        continue
      }

      const check = await this.isDeviceEligible(device, userId, {
        requireFreshHeartbeat: opts.requireFreshHeartbeat,
      })
      if (!check.eligible) continue

      const inFlight = await this.getInFlightCount(id, userId)
      const failures = await this.getRecentFailureCount(id, userId)
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
    return this.smsModel.findByIdAndUpdate(
      smsId,
      {
        $set: {
          status: 'pending',
          ...extra,
        },
        $unset: {
          leasedUntil: '',
          leasedAt: '',
          queueJobId: '',
          dispatchedAt: '',
          errorCode: '',
          errorMessage: '',
        },
      },
      { new: true },
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

    // Prefer online devices first; if none, fall back without heartbeat requirement
    let candidates = await this.listEligibleDevices(userId, {
      preferredDeviceId: preferredId,
      excludeDeviceIds: excluded,
      requireFreshHeartbeat: true,
    })
    if (candidates.length === 0) {
      candidates = await this.listEligibleDevices(userId, {
        preferredDeviceId: preferredId,
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
          $or: [
            { leasedUntil: null },
            { leasedUntil: { $exists: false } },
            { leasedUntil: { $lte: now } },
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
          $inc: { attemptCount: 1 },
          $push: {
            'metadata.dispatchAttempts': {
              at: now,
              deviceId,
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
              leasedUntil: new Date(dispatchedAt.getTime() + SMS_DISPATCH_LEASE_MS),
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

        // Permanent token errors — invalidate device token
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

        // Exclude this device and continue to next
        await this.smsModel.findByIdAndUpdate(smsId, {
          $addToSet: { excludedDeviceIds: new Types.ObjectId(deviceId) },
          $set: {
            status: 'pending',
            errorCode: errCode,
            errorMessage: errMsg,
          },
          $unset: {
            leasedUntil: '',
            leasedAt: '',
            dispatchedAt: '',
          },
        })
      } catch (error: any) {
        this.logger.error(`Dispatch exception for SMS ${smsId}`, error?.stack || error?.message)
        await this.smsModel.findByIdAndUpdate(smsId, {
          $addToSet: { excludedDeviceIds: new Types.ObjectId(deviceId) },
          $set: {
            status: 'pending',
            errorCode: getFcmErrorCode(error),
            errorMessage: getFcmErrorMessage(error),
          },
          $unset: {
            leasedUntil: '',
            leasedAt: '',
            dispatchedAt: '',
          },
        })
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
      results.push(await this.tryDispatchSms(smsId))
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
    return this.tryDispatchSms(smsId, { excludeDeviceIds: [failedDeviceId] })
  }

  /**
   * Device pull: atomically claim up to `limit` pending outbox SMS and return FCM-style payloads.
   * Also used when device receives work_available push.
   */
  async claimForDevice(
    deviceId: string,
    limit = 5,
  ): Promise<{ claimed: number; messages: any[] }> {
    const device = await this.deviceModel.findById(deviceId)
    if (!device?.enabled) {
      return { claimed: 0, messages: [] }
    }

    const userId = device.user
    const eligibility = await this.isDeviceEligible(device, userId, {
      requireFreshHeartbeat: false,
    })
    if (!eligibility.eligible) {
      return { claimed: 0, messages: [] }
    }

    const now = new Date()
    const maxClaim = Math.min(Math.max(1, limit), DEVICE_MAX_IN_FLIGHT)
    const messages: any[] = []

    for (let i = 0; i < maxClaim; i++) {
      // Prefer SMS that prefer this device
      let claimed =
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
        await this.smsModel.findByIdAndUpdate(claimed._id, {
          $set: {
            status: 'dispatched',
            dispatchedAt,
            device: device._id,
            leasedAt: dispatchedAt,
            leasedUntil: new Date(dispatchedAt.getTime() + SMS_DISPATCH_LEASE_MS),
          },
        })

        const expiresAt = claimed.expiresAt
          ? new Date(claimed.expiresAt).toISOString()
          : this.computeExpiresAt(
              new Date(claimed.requestedAt || Date.now()),
              claimed.scheduledAt ? new Date(claimed.scheduledAt) : null,
            ).toISOString()

        messages.push({
          smsId: claimed._id.toString(),
          smsBatchId: claimed.smsBatch?.toString?.() || claimed.smsBatch,
          deviceId: device._id.toString(),
          targetDeviceId: device._id.toString(),
          message: claimed.message,
          recipients: [claimed.recipient],
          expiresAt,
          simSubscriptionId: claimed.simSubscriptionId,
          smsBody: claimed.message,
          receivers: [claimed.recipient],
        })
      } catch (e: any) {
        this.logger.error(`claimForDevice processing failed: ${e?.message}`)
        await this.releaseToPending(claimed._id.toString())
      }
    }

    return { claimed: messages.length, messages }
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
      ],
      $expr: {
        $lt: [{ $ifNull: ['$attemptCount', 0] }, { $ifNull: ['$maxAttempts', SMS_MAX_ATTEMPTS] }],
      },
    }

    if (preferThisDevice) {
      filter.$and.push({
        $or: [
          { preferredDevice: device._id },
          { device: device._id },
        ],
      })
    } else {
      const myTag = normalizeAssignedTenantTag(device.assignedTenantTag)
      const allowedIds = await this.deviceIdsWithSameAssignment(userId, myTag)
      const assignmentClause: Record<string, unknown>[] = [
        { preferredDevice: { $in: allowedIds } },
      ]
      if (!myTag) {
        assignmentClause.push(
          { preferredDevice: null },
          { preferredDevice: { $exists: false } },
        )
      }
      filter.$and.push({ $or: assignmentClause })
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
          android: { priority: 'high' as const },
        }))

      if (messages.length === 0) return

      await firebaseAdmin.messaging().sendEach(messages)
    } catch (e: any) {
      this.logger.warn(`notifyWorkAvailable failed: ${e?.message}`)
    }
  }

  /**
   * How much unclaimed, still-sendable work a user has waiting right now.
   */
  async countWaitingOutbox(userId: any): Promise<number> {
    const now = new Date()
    return this.smsModel.countDocuments({
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
      ],
    })
  }

  /**
   * Drain: dispatch all waiting pending SMS for a user (or globally for cron).
   */
  async dispatchWaitingOutbox(limit = 50): Promise<number> {
    const now = new Date()
    const waiting = await this.smsModel
      .find({
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
        ],
      })
      .sort({ requestedAt: 1 })
      .limit(limit)
      .select('_id')
      .lean()

    let dispatched = 0
    for (const row of waiting) {
      const result = await this.tryDispatchSms(row._id.toString())
      if (result.status === 'dispatched') dispatched++
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
