import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Device, DeviceDocument } from './schemas/device.schema'
import { Model, Types } from 'mongoose'
import * as firebaseAdmin from 'firebase-admin'
import { DeviceTombstone, DeviceTombstoneDocument } from './schemas/device-tombstone.schema'
import {
  ReceivedSMSDTO,
  RegisterDeviceInputDTO,
  RetrieveSMSDTO,
  SendBulkSMSInputDTO,
  SendSMSInputDTO,
  UpdateSMSStatusDTO,
  HeartbeatInputDTO,
  HeartbeatResponseDTO,
} from './gateway.dto'
import { User } from '../users/schemas/user.schema'
import { AuthService } from '../auth/auth.service'
import { SMS } from './schemas/sms.schema'
import { SMSType } from './sms-type.enum'
import { SMSBatch } from './schemas/sms-batch.schema'
import { BatchResponse, Message } from 'firebase-admin/messaging'
import { WebhookEvent } from '../webhook/webhook-event.enum'
import { WebhookService } from '../webhook/webhook.service'
import { BillingService } from '../billing/billing.service'
import { SmsQueueService } from './queue/sms-queue.service'
import { SmsOutboxService } from './sms-outbox.service'
import {
  DEVICE_FAILURE_COOLDOWN_MINUTES,
  DEVICE_FAILURE_THRESHOLD,
  DEVICE_FAILED_SEND_STATUSES,
  DEVICE_IN_FLIGHT_STATUSES,
  DEVICE_MAX_IN_FLIGHT,
  RESENDABLE_BLOCKED_STATUSES,
  SMS_MAX_ATTEMPTS,
} from './sms-delivery.constants'

type MessageListParams = {
  page?: number
  limit?: number
  type?: string
  status?: string
  deviceId?: string
  search?: string
  from?: string
  to?: string
}

type QueueRehydrateResult = {
  jobId: string
  smsIds: string[]
  delayMs?: number
}

/** @deprecated use DEVICE_MAX_IN_FLIGHT / DEVICE_FAILURE_THRESHOLD */
const DEVICE_SEND_COOLDOWN_LIMIT = DEVICE_MAX_IN_FLIGHT
const DEVICE_ACTIVE_SEND_STATUSES = DEVICE_IN_FLIGHT_STATUSES

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getUserObjectId(user: User): any {
  return (user as any)?._id || (user as any)?.id
}

function normalizeTenantTag(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return undefined
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new HttpException(
      {
        success: false,
        error: 'Invalid tenant tag',
        message:
          'tenantTag must be 1-64 characters: letters, numbers, underscore, or hyphen.',
      },
      HttpStatus.BAD_REQUEST,
    )
  }
  return normalized
}

function assertDeviceCanAcceptTenant(device: any, tenantTag?: string): void {
  if (!tenantTag) return
  const deviceTenantTag = normalizeTenantTag(device?.assignedTenantTag)
  if (deviceTenantTag && deviceTenantTag !== tenantTag) {
    throw new HttpException(
      {
        success: false,
        error: 'Device tenant assignment changed',
        message:
          'The selected device is now assigned to another school. Refresh the device pool and retry.',
      },
      HttpStatus.CONFLICT,
    )
  }
}

@Injectable()
export class GatewayService {
  constructor(
    @InjectModel(Device.name) private deviceModel: Model<DeviceDocument>,
    @InjectModel(DeviceTombstone.name)
    private deviceTombstoneModel: Model<DeviceTombstoneDocument>,
    @InjectModel(SMS.name) private smsModel: Model<SMS>,
    @InjectModel(SMSBatch.name) private smsBatchModel: Model<SMSBatch>,
    private authService: AuthService,
    private webhookService: WebhookService,
    private billingService: BillingService,
    private smsQueueService: SmsQueueService,
    private smsOutboxService: SmsOutboxService,
  ) {}

  private coercePage(value: unknown, fallback = 1): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
  }

  private coerceLimit(value: unknown, fallback = 50): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback
    }
    return Math.min(Math.floor(parsed), 100)
  }

  private getSortableDateFilter(params: MessageListParams): Record<string, any> | null {
    const createdAt: Record<string, Date> = {}
    if (params.from) {
      const from = new Date(params.from)
      if (!Number.isNaN(from.getTime())) {
        createdAt.$gte = from
      }
    }
    if (params.to) {
      const to = new Date(params.to)
      if (!Number.isNaN(to.getTime())) {
        createdAt.$lte = to
      }
    }
    return Object.keys(createdAt).length > 0 ? { createdAt } : null
  }

  private buildMessageSearchFilter(search?: string): Record<string, any> | null {
    const trimmed = search?.trim()
    if (!trimmed) {
      return null
    }

    const regex = new RegExp(escapeRegExp(trimmed), 'i')
    return {
      $or: [
        { message: regex },
        { recipient: regex },
        { sender: regex },
        { status: regex },
        { errorCode: regex },
        { errorMessage: regex },
      ],
    }
  }

  private getMessageUserFilter(user: User): Record<string, any> {
    return { user: getUserObjectId(user) }
  }

  private async getMessageBatchIds(query: Record<string, any>): Promise<any[]> {
    const batchIds = await this.smsModel.distinct('smsBatch', query)
    return Array.isArray(batchIds) ? batchIds.filter(Boolean) : []
  }

  private async deleteOrphanedMessageBatches(
    batchIds: any[],
    user: User,
  ): Promise<void> {
    if (!batchIds.length) {
      return
    }

    const stillReferenced = await this.smsModel.distinct('smsBatch', {
      smsBatch: { $in: batchIds },
    })
    const referencedIds = new Set(
      (Array.isArray(stillReferenced) ? stillReferenced : []).map((batchId) =>
        batchId?.toString?.(),
      ),
    )
    const orphanedBatchIds = batchIds.filter(
      (batchId) => !referencedIds.has(batchId?.toString?.()),
    )

    if (orphanedBatchIds.length > 0) {
      await this.smsBatchModel.deleteMany({
        _id: { $in: orphanedBatchIds },
        ...this.getMessageUserFilter(user),
      })
    }
  }

  private getDeviceFilterValue(deviceId?: string): Types.ObjectId | undefined {
    if (!deviceId || deviceId === 'all') {
      return undefined
    }

    if (!Types.ObjectId.isValid(deviceId)) {
      throw new HttpException(
        {
          success: false,
          error: 'deviceId is invalid',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    return new Types.ObjectId(deviceId)
  }

  private async assertMessageBelongsToUser(smsId: string, user: User): Promise<any> {
    const sms = await this.smsModel.findById(smsId)
    if (!sms) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    if (sms.user?.toString() !== getUserObjectId(user)?.toString()) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS does not belong to this account',
        },
        HttpStatus.FORBIDDEN,
      )
    }

    return sms
  }

  private async markQueuedSmsJobs(
    queuedJobs: QueueRehydrateResult[],
    queuedAt = new Date(),
  ): Promise<void> {
    if (!Array.isArray(queuedJobs)) {
      return
    }

    for (const queuedJob of queuedJobs || []) {
      if (!queuedJob.smsIds?.length) {
        continue
      }
      const scheduledAt =
        queuedJob.delayMs !== undefined && queuedJob.delayMs > 0
          ? new Date(queuedAt.getTime() + queuedJob.delayMs)
          : undefined
      await this.smsModel.updateMany(
        { _id: { $in: queuedJob.smsIds } as any },
        {
          $set: {
            queueJobId: queuedJob.jobId,
            queuedAt,
            ...(scheduledAt && { scheduledAt }),
          },
        },
      )
    }
  }

  private async requeueRemainingMessages(
    result: {
      remainingFcmMessages: any[]
      remainingDelayMs?: number
      deviceId?: string
      smsBatchId?: string
    },
  ): Promise<void> {
    if (!result.remainingFcmMessages?.length || !result.deviceId || !result.smsBatchId) {
      return
    }

    const queuedJobs = await this.smsQueueService.addSendSmsJob(
      result.deviceId,
      result.remainingFcmMessages,
      result.smsBatchId,
      result.remainingDelayMs,
    )
    await this.markQueuedSmsJobs(queuedJobs)
  }

  private buildFcmMessageForSms(sms: any, device: any): Message {
    const updatedSMSData = {
      smsId: sms._id,
      smsBatchId: sms.smsBatch,
      deviceId: device._id.toString(),
      targetDeviceId: device._id.toString(),
      message: sms.message,
      recipients: [sms.recipient],
      ...(sms.simSubscriptionId !== undefined && {
        simSubscriptionId: sms.simSubscriptionId,
      }),

      // Legacy fields to be removed in the future
      smsBody: sms.message,
      receivers: [sms.recipient],
    }

    return {
      data: {
        smsData: JSON.stringify(updatedSMSData),
        targetDeviceId: device._id.toString(),
      },
      token: device.fcmToken,
      android: {
        priority: 'high',
      },
    }
  }

  private async refreshBatchStatusFromMessages(smsBatchId?: string): Promise<void> {
    if (!smsBatchId) {
      return
    }

    const allSmsInBatch = await this.smsModel.find({ smsBatch: smsBatchId })
    if (!allSmsInBatch?.length) {
      return
    }

    const statuses = allSmsInBatch.map((sms: any) => String(sms.status).toLowerCase())
    const allCanceled = statuses.every((status) => status === 'canceled')
    const allTerminal = statuses.every((status) =>
      ['sent', 'delivered', 'failed', 'unknown', 'received', 'canceled'].includes(status),
    )
    const anyFailed = statuses.some((status) => status === 'failed' || status === 'unknown')
    const anyCanceled = statuses.some((status) => status === 'canceled')

    if (allCanceled) {
      await this.smsBatchModel.findByIdAndUpdate(smsBatchId, {
        $set: { status: 'canceled', completedAt: new Date() },
      })
      return
    }

    if (allTerminal && (anyFailed || anyCanceled)) {
      await this.smsBatchModel.findByIdAndUpdate(smsBatchId, {
        $set: { status: 'partial_success', completedAt: new Date() },
      })
    }
  }

  private getDeviceIdString(device: any): string {
    return device?._id?.toString?.() || device?.toString?.()
  }

  private getDeviceUserId(device: any): any {
    return device?.user?._id || device?.user
  }

  private async getDeviceSendHealth(device: any): Promise<{
    activeCount: number
    recentIssueCount: number
    limit: number
    failureThreshold: number
    cooldownMinutes: number
  }> {
    const deviceId = this.getDeviceIdString(device)
    const userId = this.getDeviceUserId(device)
    const summary = await this.smsOutboxService.getDeviceHealthSummary(
      deviceId,
      userId,
    )

    return {
      activeCount: summary.inFlight,
      recentIssueCount: summary.recentFailures,
      limit: summary.maxInFlight,
      failureThreshold: summary.failureThreshold,
      cooldownMinutes: summary.failureCooldownMinutes,
    }
  }

  /**
   * Soft check for explicit pin-to-device operations (reroute target).
   * Enqueue path no longer hard-blocks: outbox assigns any free device.
   */
  private async assertDeviceCanAcceptSend(device: any): Promise<void> {
    const health = await this.getDeviceSendHealth(device)
    const activeBlocked = health.activeCount >= DEVICE_MAX_IN_FLIGHT
    const issueBlocked = health.recentIssueCount >= DEVICE_FAILURE_THRESHOLD

    if (!activeBlocked && !issueBlocked) {
      return
    }

    const reason = activeBlocked
      ? `Device already has ${health.activeCount} in-flight SMS (cap ${DEVICE_MAX_IN_FLIGHT}). Cancel, reroute, or wait.`
      : `Device has ${health.recentIssueCount} failed/unknown SMS in the last ${DEVICE_FAILURE_COOLDOWN_MINUTES} minutes. It is paused for safety.`

    throw new HttpException(
      {
        success: false,
        error: reason,
        message: reason,
        deviceId: this.getDeviceIdString(device),
        activePendingOrDispatched: health.activeCount,
        recentFailedOrUnknown: health.recentIssueCount,
        cooldownLimit: health.failureThreshold,
        cooldownMinutes: health.cooldownMinutes,
        maxInFlight: health.limit,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }

  // Blocks creating or re-enabling a device when the user's plan device limit
  // is reached. Effective limit comes from the subscription override or the
  // plan (deviceLimit of -1 or missing means unlimited). Only enabled devices
  // count toward the limit. Fails open if the limit lookup itself errors.
  private async assertDeviceLimitNotReached(
    userId: Types.ObjectId | string,
    { excludeDeviceId }: { excludeDeviceId?: Types.ObjectId | string } = {},
  ): Promise<void> {
    let deviceLimit: number
    try {
      const limits = await this.billingService.getUserLimits(
        userId?.toString(),
      )
      deviceLimit = limits?.deviceLimit ?? -1
    } catch (error) {
      console.error('assertDeviceLimitNotReached: failed to load limits', error)
      return
    }

    if (deviceLimit == null || deviceLimit === -1) {
      return
    }

    const filter: any = { user: userId, enabled: true }
    if (excludeDeviceId) {
      filter._id = { $ne: excludeDeviceId }
    }
    const activeDeviceCount = await this.deviceModel.countDocuments(filter)

    if (activeDeviceCount >= deviceLimit) {
      this.billingService
        .notifyDeviceLimitReached(userId, deviceLimit, activeDeviceCount)
        .catch((error) => {
          console.error('failed to send device limit notification', error)
        })

      throw new HttpException(
        {
          message: `Active device limit reached - your plan allows up to ${deviceLimit} active device(s) and you have ${activeDeviceCount}. Disable or delete another device, or upgrade your plan at https://sms.gabay.online/checkout/pro`,
          hasReachedLimit: true,
          deviceLimit,
          activeDeviceCount,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  async registerDevice(
    input: RegisterDeviceInputDTO,
    user: User,
  ): Promise<any> {
    // The FCM token is the only per-install identity the client sends, so it is
    // the only safe way to recognise a handset that is re-registering. Never
    // match on model/buildId alone: two identical phones on the same ROM share
    // both, and reusing that row hands the second phone the first phone's
    // device record (the first device then disappears from the account).
    let device = input.fcmToken
      ? await this.deviceModel.findOne({
          user: user._id,
          fcmToken: input.fcmToken,
        } as any)
      : null

    // Legacy clients (appVersionCode <= 11) never sent a usable token; keep the
    // original model/buildId re-enable path for them only.
    if (!device) {
      // Mongoose 9.6's strict types collide on the reserved `model` field name
      // (it expects Mongoose's `Model<any>` shape, not the device's `model`
      // schema field). Cast the filter to bypass the type check; runtime
      // behavior is unchanged.
      const legacyDevice = await this.deviceModel.findOne({
        user: user._id,
        model: input.model,
        buildId: input.buildId,
      } as any)
      if (legacyDevice && legacyDevice.appVersionCode <= 11) {
        device = legacyDevice
      }
    }

    const now = new Date()
    const deviceData: any = { ...input, user }
    // Android register/heartbeat payloads must never create or clear a school assignment.
    delete deviceData.assignedTenantTag
    
    // Set default name to "brand model" if not provided
    if (!deviceData.name && input.brand && input.model) {
      deviceData.name = `${input.brand} ${input.model}`
    }
    
    // Handle simInfo if provided
    if (input.simInfo) {
      deviceData.simInfo = {
        ...input.simInfo,
        lastUpdated: input.simInfo.lastUpdated || now,
      }
    }

    if (input.fcmToken) {
      deviceData.fcmTokenUpdatedAt = now
      deviceData.fcmTokenInvalidatedAt = undefined
      deviceData.fcmTokenInvalidReason = undefined
    }

    if (device) {
      // Same app install re-registering: update its row rather than adding a
      // second one, so the outbox never pushes to a stale device id that the
      // phone no longer recognises.
      // updateDevice enforces the device limit on the disabled -> enabled transition.
      return await this.updateDevice(device._id.toString(), {
        ...deviceData,
        enabled: input.enabled ?? true,
      })
    }

    await this.assertDeviceLimitNotReached(user._id)
    deviceData.enabled = input.enabled ?? true
    const created: any = await this.deviceModel.create(deviceData)
    await this.detachFcmTokenFromOtherDevices(
      user._id,
      created?._id,
      input.fcmToken,
    )
    return created
  }

  /**
   * An FCM token addresses exactly one app instance. If an older device row for
   * the same user still holds it, that row is a stale duplicate of the same
   * handset — clear its token so device selection stops pushing into a void.
   */
  private async detachFcmTokenFromOtherDevices(
    userId: any,
    keepDeviceId: any,
    fcmToken?: string,
  ): Promise<void> {
    if (!fcmToken) return
    try {
      await this.deviceModel.updateMany(
        {
          user: userId,
          fcmToken,
          _id: { $ne: keepDeviceId },
        } as any,
        {
          $unset: { fcmToken: '' },
          $set: {
            fcmTokenInvalidatedAt: new Date(),
            fcmTokenInvalidReason: 'REPLACED_BY_NEWER_DEVICE_REGISTRATION',
          },
        },
      )
    } catch (e) {
      console.error('failed to detach duplicate FCM token', e)
    }
  }

  async getDevicesForUser(user: User): Promise<any> {
    return await this.deviceModel.find({ user: user._id })
  }

  async getDeviceById(deviceId: string): Promise<any> {
    return await this.deviceModel.findById(deviceId)
  }

  async updateDevice(
    deviceId: string,
    input: RegisterDeviceInputDTO,
  ): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          error: 'Device not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    if (input.enabled !== false) {
      input.enabled = true;
    }

    // enforce the device limit only on the disabled -> enabled transition so
    // routine updates of already-enabled devices are never blocked
    if (!device.enabled && input.enabled) {
      await this.assertDeviceLimitNotReached(device.user as Types.ObjectId, {
        excludeDeviceId: device._id,
      })
    }

    const now = new Date()
    const updateData: any = { ...input }
    // Assignment is owned by PATCH /devices/:id/assignment, not device register/heartbeat.
    delete updateData.assignedTenantTag
    
    // Handle simInfo if provided
    if (input.simInfo) {
      updateData.simInfo = {
        ...input.simInfo,
        lastUpdated: input.simInfo.lastUpdated || now,
      }
    }

    if (input.fcmToken && input.fcmToken !== device.fcmToken) {
      updateData.fcmTokenUpdatedAt = now
      updateData.fcmTokenInvalidatedAt = undefined
      updateData.fcmTokenInvalidReason = undefined
    }

    const previousEnabled = !!device.enabled
    const updated = await this.deviceModel.findByIdAndUpdate(
      deviceId,
      { $set: updateData },
      { new: true },
    )

    if (input.fcmToken) {
      await this.detachFcmTokenFromOtherDevices(
        device.user,
        device._id,
        input.fcmToken,
      )
    }

    // When web/API toggles gateway, push config so the phone switch updates immediately
    if (updated && previousEnabled !== !!updated.enabled) {
      this.pushDeviceConfig(updated).catch(() => undefined)
    }

    return updated
  }

  async assignDeviceTenant(
    deviceId: string,
    assignedTenantTag?: string | null,
  ): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          error: 'Device not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    const normalized =
      typeof assignedTenantTag === 'string' ? assignedTenantTag.trim() : ''

    if (normalized && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(normalized)) {
      throw new HttpException(
        {
          error: 'Invalid tenant tag',
          message:
            'assignedTenantTag must be 1-64 characters: letters, numbers, underscore, or hyphen.',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const updated = normalized
      ? await this.deviceModel.findByIdAndUpdate(
          deviceId,
          { $set: { assignedTenantTag: normalized } },
          { new: true },
        )
      : await this.deviceModel.findByIdAndUpdate(
          deviceId,
          { $unset: { assignedTenantTag: 1 } },
          { new: true },
        )

    return updated
  }

  async deleteDevice(deviceId: string): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          error: 'Device not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    await this.deviceTombstoneModel.updateOne(
      { deviceId: new Types.ObjectId(deviceId) },
      {
        $setOnInsert: {
          deviceId: new Types.ObjectId(deviceId),
          userId: device.user,
          deletedAt: new Date(),
        },
      },
      { upsert: true },
    )

    await this.deviceModel.findByIdAndDelete(deviceId)

    return { success: true }
  }

  private calculateDelayFromScheduledAt(scheduledAt?: string): number | undefined {
    if (!scheduledAt) {
      return undefined
    }

    try {
      const scheduledDate = new Date(scheduledAt)
      
      // Check if date is valid
      if (isNaN(scheduledDate.getTime())) {
        throw new HttpException(
          {
            success: false,
            error: 'Invalid scheduledAt format. Must be a valid ISO 8601 date string.',
          },
          HttpStatus.BAD_REQUEST,
        )
      }

      const now = Date.now()
      const scheduledTime = scheduledDate.getTime()
      const delayMs = scheduledTime - now

      // Reject past dates
      if (delayMs < 0) {
        throw new HttpException(
          {
            success: false,
            error: 'scheduledAt must be a future date',
          },
          HttpStatus.BAD_REQUEST,
        )
      }

      return delayMs
    } catch (error) {
      if (error instanceof HttpException) {
        throw error
      }
      throw new HttpException(
        {
          success: false,
          error: 'Invalid scheduledAt format. Must be a valid ISO 8601 date string.',
        },
        HttpStatus.BAD_REQUEST,
      )
    }
  }

  /**
   * Enqueue outbound SMS into the central outbox.
   * `deviceId` is the preferred device; any free eligible device may claim/send.
   */
  async sendSMS(deviceId: string, smsData: SendSMSInputDTO): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device?.enabled) {
      throw new HttpException(
        {
          success: false,
          error: 'Device does not exist or is not enabled',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const message = smsData.message || smsData.smsBody
    const recipients = smsData.recipients || smsData.receivers
    const tenantTag = normalizeTenantTag(smsData.tenantTag)
    assertDeviceCanAcceptTenant(device, tenantTag)

    if (!message) {
      throw new HttpException(
        {
          success: false,
          error: 'Message cannot be blank',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new HttpException(
        {
          success: false,
          error: 'Invalid recipients',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    // Scheduling still supported via scheduledAt on the SMS row
    const delayMs = this.calculateDelayFromScheduledAt(smsData.scheduledAt)
    const scheduledAtDate =
      delayMs !== undefined && delayMs > 0
        ? new Date(Date.now() + delayMs)
        : smsData.scheduledAt
          ? new Date(smsData.scheduledAt)
          : undefined

    await this.billingService.canPerformAction(
      device.user.toString(),
      'send_sms',
      recipients.length,
    )

    let smsBatch: SMSBatch

    try {
      smsBatch = await this.smsBatchModel.create({
        user: device.user,
        device: device._id,
        message,
        recipientCount: recipients.length,
        recipientPreview: this.getRecipientsPreview(recipients),
        status: 'pending',
      })
    } catch (e) {
      throw new HttpException(
        {
          success: false,
          error: 'Failed to create SMS batch',
          additionalInfo: e,
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const requestedAt = new Date()
    const expiresAt = this.smsOutboxService.computeExpiresAt(
      requestedAt,
      scheduledAtDate || null,
    )
    const smsIds: string[] = []

    for (let recipient of recipients) {
      recipient = recipient.replace(/\s+/g, '')
      const sms = await this.smsModel.create({
        user: device.user,
        device: device._id,
        preferredDevice: device._id,
        ...(tenantTag && { tenantTag }),
        smsBatch: smsBatch._id,
        message,
        type: SMSType.SENT,
        recipient,
        requestedAt,
        scheduledAt: scheduledAtDate,
        expiresAt,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: SMS_MAX_ATTEMPTS,
        excludedDeviceIds: [],
        ...(smsData.simSubscriptionId !== undefined && {
          simSubscriptionId: smsData.simSubscriptionId,
        }),
      })
      smsIds.push(sms._id.toString())
    }

    await this.smsBatchModel.findByIdAndUpdate(smsBatch._id, {
      $set: { status: 'processing' },
    })

    // Immediate multi-device dispatch (central outbox)
    const dispatchResults = await this.smsOutboxService.dispatchMany(smsIds)
    const dispatched = dispatchResults.filter((r) => r.status === 'dispatched').length
    const pending = dispatchResults.filter((r) => r.status === 'pending').length
    const failed = dispatchResults.filter((r) => r.status === 'failed').length
    const canceled = dispatchResults.filter((r) => r.status === 'canceled').length

    if (dispatched + pending > 0) {
      await this.smsBatchModel.findByIdAndUpdate(smsBatch._id, {
        $set: {
          status:
            failed + canceled > 0 && dispatched + pending > 0
              ? 'partial_success'
              : dispatched === recipients.length
                ? 'processing'
                : 'processing',
        },
      })
    }

    return {
      success: true,
      message:
        pending > 0
          ? 'SMS accepted into outbox; waiting for free device(s) where needed'
          : 'SMS dispatched to free device(s)',
      smsBatchId: smsBatch._id,
      recipientCount: recipients.length,
      outbox: {
        dispatched,
        pending,
        failed,
        canceled,
        results: dispatchResults,
      },
    }
  }

  async sendBulkSMS(deviceId: string, body: SendBulkSMSInputDTO): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device?.enabled) {
      throw new HttpException(
        {
          success: false,
          error: 'Device does not exist or is not enabled',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      body.messages.map((m) => m.recipients).flat().length === 0
    ) {
      throw new HttpException(
        {
          success: false,
          error: 'Invalid message list',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    for (const smsData of body.messages) {
      assertDeviceCanAcceptTenant(device, normalizeTenantTag(smsData.tenantTag))
    }

    await this.billingService.canPerformAction(
      device.user.toString(),
      'bulk_send_sms',
      body.messages.map((m) => m.recipients).flat().length,
    )

    const { messageTemplate, messages } = body
    const requestedAt = new Date()

    const smsBatch = await this.smsBatchModel.create({
      user: device.user,
      device: device._id,
      message: messageTemplate,
      recipientCount: messages
        .map((m) => m.recipients.length)
        .reduce((a, b) => a + b, 0),
      recipientPreview: this.getRecipientsPreview(
        messages.map((m) => m.recipients).flat(),
      ),
      status: 'pending',
    })

    const smsDocumentsToInsert: Array<Record<string, any>> = []

    for (const smsData of messages) {
      const message = smsData.message
      const recipients = smsData.recipients
      const tenantTag = normalizeTenantTag(smsData.tenantTag)

      if (!message || !Array.isArray(recipients) || recipients.length === 0) {
        continue
      }

      const delayMs = this.calculateDelayFromScheduledAt(smsData.scheduledAt)
      const scheduledAtDate =
        delayMs !== undefined && delayMs > 0
          ? new Date(Date.now() + delayMs)
          : smsData.scheduledAt
            ? new Date(smsData.scheduledAt)
            : undefined
      const expiresAt = this.smsOutboxService.computeExpiresAt(
        requestedAt,
        scheduledAtDate || null,
      )

      for (let recipient of recipients) {
        recipient = recipient.replace(/\s+/g, '')
        smsDocumentsToInsert.push({
          user: device.user,
          device: device._id,
          preferredDevice: device._id,
          ...(tenantTag && { tenantTag }),
          smsBatch: smsBatch._id,
          message,
          type: SMSType.SENT,
          recipient,
          requestedAt,
          scheduledAt: scheduledAtDate,
          expiresAt,
          status: 'pending',
          attemptCount: 0,
          maxAttempts: SMS_MAX_ATTEMPTS,
          excludedDeviceIds: [],
          ...(smsData.simSubscriptionId !== undefined && {
            simSubscriptionId: smsData.simSubscriptionId,
          }),
        })
      }
    }

    const insertChunkSize = 500
    const insertedSmsDocs: any[] = []
    const hasInsertMany = typeof (this.smsModel as any).insertMany === 'function'
    for (let i = 0; i < smsDocumentsToInsert.length; i += insertChunkSize) {
      const chunk = smsDocumentsToInsert.slice(i, i + insertChunkSize)
      if (hasInsertMany) {
        const insertedChunk = await (this.smsModel as any).insertMany(chunk, {
          ordered: true,
        })
        insertedSmsDocs.push(...insertedChunk)
        continue
      }
      for (const smsDocument of chunk) {
        const createdSmsDoc = await this.smsModel.create(smsDocument)
        insertedSmsDocs.push(createdSmsDoc)
      }
    }

    const smsIds = insertedSmsDocs.map((s) => s._id.toString())
    await this.smsBatchModel.findByIdAndUpdate(smsBatch._id, {
      $set: { status: 'processing' },
    })

    const dispatchResults = await this.smsOutboxService.dispatchMany(smsIds)
    const dispatched = dispatchResults.filter((r) => r.status === 'dispatched').length
    const pending = dispatchResults.filter((r) => r.status === 'pending').length
    const failed = dispatchResults.filter((r) => r.status === 'failed').length

    return {
      success: true,
      message: 'Bulk SMS accepted into outbox',
      smsBatchId: smsBatch._id,
      recipientCount: smsIds.length,
      successCount: dispatched,
      failureCount: failed,
      pendingCount: pending,
      outbox: {
        dispatched,
        pending,
        failed,
      },
    }
  }

  async receiveSMS(deviceId: string, dto: ReceivedSMSDTO): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          success: false,
          error: 'Device does not exist',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (
      (!dto.receivedAt && !dto.receivedAtInMillis) ||
      !dto.sender ||
      !dto.message
    ) {
      console.error(`receiveSMS: Invalid received SMS data (sender: ${dto.sender}, message: ${dto.message}) (receivedAt: ${dto.receivedAt}, receivedAtInMillis: ${dto.receivedAtInMillis})`)
      throw new HttpException(
        {
          success: false,
          error: 'Invalid received SMS data',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.billingService.canPerformAction(
      device.user.toString(),
      'receive_sms',
      1,
    )

    const receivedAt = dto.receivedAtInMillis
      ? new Date(dto.receivedAtInMillis)
      : dto.receivedAt

    // Deduplication: Check for existing SMS with same device, sender, message, and receivedAt (within ±5 seconds tolerance)
    const toleranceMs = 5000 // 5 seconds
    const toleranceStart = new Date(receivedAt.getTime() - toleranceMs)
    const toleranceEnd = new Date(receivedAt.getTime() + toleranceMs)

    const existingSMS = await this.smsModel.findOne({
      device: device._id,
      type: SMSType.RECEIVED,
      sender: dto.sender,
      message: dto.message,
      receivedAt: {
        $gte: toleranceStart,
        $lte: toleranceEnd,
      },
    })

    if (existingSMS) {
      console.log(
        `Duplicate SMS detected for device ${deviceId}, sender ${dto.sender}, returning existing record: ${existingSMS._id}`,
      )
      return existingSMS
    }

    const sms = await this.smsModel.create({
      user: device.user,
      device: device._id,
      message: dto.message,
      type: SMSType.RECEIVED,
      status: 'received',
      sender: dto.sender,
      receivedAt,
    })

    this.deviceModel
      .findByIdAndUpdate(deviceId, {
        $inc: { receivedSMSCount: 1 },
      })
      .exec()
      .catch((e) => {
        console.log('Failed to update receivedSMSCount')
        console.log(e)
      })

    this.webhookService
      .deliverNotification({
        sms,
        user: device.user,
        event: WebhookEvent.MESSAGE_RECEIVED,
      })
      .catch((e) => {
        console.log(e)
      })

    return sms
  }

  async getReceivedSMS(
    deviceId: string,
    page = 1,
    limit = 50,
  ): Promise<{ data: any[]; meta: any }> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          success: false,
          error: 'Device does not exist',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    // Calculate skip value for pagination
    const skip = (page - 1) * limit

    // Get total count for pagination metadata
    const total = await this.smsModel.countDocuments({
      device: device._id,
      type: SMSType.RECEIVED,
    })

    // @ts-ignore
    const data = await this.smsModel
      .find(
        {
          device: device._id,
          type: SMSType.RECEIVED,
        },
        null,
        {
          sort: { receivedAt: -1 },
          limit: limit,
          skip: skip,
        },
      )
      .populate({
        path: 'device',
        select: '_id brand model buildId enabled',
      })
      .lean() // Use lean() to return plain JavaScript objects instead of Mongoose documents

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limit)

    return {
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
      data,
    }
  }

  async getMessages(
    deviceId: string,
    type = '',
    page = 1,
    limit = 50,
  ): Promise<{ data: any[]; meta: any }> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          success: false,
          error: 'Device does not exist',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    // Calculate skip value for pagination
    const skip = (page - 1) * limit

    // Build query based on type filter
    const query: any = { device: device._id }

    if (type === 'sent') {
      query.type = SMSType.SENT
    } else if (type === 'received') {
      query.type = SMSType.RECEIVED
    }

    // Get total count for pagination metadata
    const total = await this.smsModel.countDocuments(query)

    // @ts-ignore
    const data = await this.smsModel
      .find(query, null, {
        // Sort by the most recent timestamp (receivedAt for received, sentAt for sent)
        sort: { createdAt: -1 },
        limit: limit,
        skip: skip,
      })
      .populate({
        path: 'device',
        select: '_id brand model buildId enabled',
      })
      .lean() // Use lean() to return plain JavaScript objects instead of Mongoose documents

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limit)

    return {
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
      data,
    }
  }

  async getAccountMessages(
    user: User,
    params: MessageListParams = {},
  ): Promise<{ data: any[]; meta: any; summary: Record<string, number> }> {
    const page = this.coercePage(params.page, 1)
    const limit = this.coerceLimit(params.limit, 50)
    const skip = (page - 1) * limit
    const deviceFilterValue = this.getDeviceFilterValue(params.deviceId)

    const query: any = {
      ...this.getMessageUserFilter(user),
    }

    if (deviceFilterValue) {
      query.device = deviceFilterValue
    }

    if (params.type === 'sent') {
      query.type = SMSType.SENT
    } else if (params.type === 'received') {
      query.type = SMSType.RECEIVED
    }

    if (params.status && params.status !== 'all') {
      query.status = params.status
    }

    const dateFilter = this.getSortableDateFilter(params)
    if (dateFilter) {
      Object.assign(query, dateFilter)
    }

    const searchFilter = this.buildMessageSearchFilter(params.search)
    if (searchFilter) {
      Object.assign(query, searchFilter)
    }

    const summaryBaseQuery = {
      ...this.getMessageUserFilter(user),
      ...(deviceFilterValue ? { device: deviceFilterValue } : {}),
      ...(params.type === 'sent'
        ? { type: SMSType.SENT }
        : params.type === 'received'
          ? { type: SMSType.RECEIVED }
          : {}),
      ...(dateFilter || {}),
      ...(searchFilter || {}),
    }

    const [
      total,
      pending,
      dispatched,
      sent,
      delivered,
      failed,
      unknown,
      received,
      canceled,
    ] = await Promise.all([
      this.smsModel.countDocuments(query),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'pending' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'dispatched' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'sent' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'delivered' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'failed' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'unknown' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'received' }),
      this.smsModel.countDocuments({ ...summaryBaseQuery, status: 'canceled' }),
    ])

    const data = await this.smsModel
      .find(query, null, {
        sort: { createdAt: -1 },
        limit,
        skip,
      })
      .populate({
        path: 'device',
        select: '_id brand model buildId enabled name',
      })
      .lean()

    return {
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        pending,
        dispatched,
        sent,
        delivered,
        failed,
        unknown,
        received,
        canceled,
      },
      data,
    }
  }

  async cancelPendingSms(
    smsId: string,
    user: User,
    reason?: string,
  ): Promise<any> {
    const sms = await this.assertMessageBelongsToUser(smsId, user)

    if (sms.status !== 'pending') {
      throw new HttpException(
        {
          success: false,
          error: `Only pending SMS can be canceled. Current status is ${sms.status}.`,
        },
        HttpStatus.CONFLICT,
      )
    }

    if (!sms.queueJobId) {
      throw new HttpException(
        {
          success: false,
          error: 'This SMS is pending but not linked to a cancellable queue job.',
        },
        HttpStatus.CONFLICT,
      )
    }

    const removal = await this.smsQueueService.removeSmsFromWaitingJob(
      sms.queueJobId,
      smsId,
    )
    if (!removal.removed) {
      throw new HttpException(
        {
          success: false,
          error: removal.reason || 'SMS can no longer be canceled.',
          queueState: removal.state,
        },
        HttpStatus.CONFLICT,
      )
    }

    await this.requeueRemainingMessages(removal)

    const canceledAt = new Date()
    const metadata = {
      ...(sms.metadata || {}),
      canceledReason: reason || 'Canceled from dashboard',
      canceledFromQueueJobId: sms.queueJobId,
    }

    const updatedSms = await this.smsModel
      .findByIdAndUpdate(
        smsId,
        {
          $set: {
            status: 'canceled',
            canceledAt,
            metadata,
          },
          $unset: {
            queueJobId: '',
            scheduledAt: '',
          },
        },
        { new: true },
      )
      .populate({
        path: 'device',
        select: '_id brand model buildId enabled name',
      })

    await this.refreshBatchStatusFromMessages(sms.smsBatch?.toString())

    return {
      success: true,
      message: 'Pending SMS canceled',
      data: updatedSms,
    }
  }

  async reroutePendingSms(
    smsId: string,
    targetDeviceId: string,
    user: User,
  ): Promise<any> {
    if (!targetDeviceId) {
      throw new HttpException(
        {
          success: false,
          error: 'targetDeviceId is required',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const sms = await this.assertMessageBelongsToUser(smsId, user)

    if (sms.status !== 'pending') {
      throw new HttpException(
        {
          success: false,
          error: `Only pending SMS can be rerouted. Current status is ${sms.status}.`,
        },
        HttpStatus.CONFLICT,
      )
    }

    if (!sms.queueJobId) {
      throw new HttpException(
        {
          success: false,
          error: 'This SMS is pending but not linked to a reroutable queue job.',
        },
        HttpStatus.CONFLICT,
      )
    }

    const targetDevice = await this.deviceModel.findById(targetDeviceId)
    if (!targetDevice?.enabled) {
      throw new HttpException(
        {
          success: false,
          error: 'Target device does not exist or is not enabled',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (targetDevice.user?.toString() !== getUserObjectId(user)?.toString()) {
      throw new HttpException(
        {
          success: false,
          error: 'Target device does not belong to this account',
        },
        HttpStatus.FORBIDDEN,
      )
    }

    if (sms.device?.toString() === targetDevice._id.toString()) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS is already routed to the selected device',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.assertDeviceCanAcceptSend(targetDevice)

    const removal = await this.smsQueueService.removeSmsFromWaitingJob(
      sms.queueJobId,
      smsId,
    )
    if (!removal.removed) {
      throw new HttpException(
        {
          success: false,
          error: removal.reason || 'SMS can no longer be rerouted.',
          queueState: removal.state,
        },
        HttpStatus.CONFLICT,
      )
    }

    await this.requeueRemainingMessages(removal)

    const reroutedAt = new Date()
    const metadata = {
      ...(sms.metadata || {}),
      reroutedAt,
      reroutedFromDeviceId: sms.device?.toString(),
      reroutedToDeviceId: targetDevice._id.toString(),
      reroutedFromQueueJobId: sms.queueJobId,
    }

    await this.smsModel.findByIdAndUpdate(smsId, {
      $set: {
        device: targetDevice._id,
        metadata,
      },
      $unset: {
        queueJobId: '',
        scheduledAt: '',
      },
    })

    const reroutedSms = {
      ...((typeof (sms as any).toObject === 'function' ? (sms as any).toObject() : sms) as any),
      device: targetDevice._id,
    }
    const reroutedMessage = this.buildFcmMessageForSms(reroutedSms, targetDevice)
    const queuedJobs = await this.smsQueueService.addSendSmsJob(
      targetDevice._id.toString(),
      [reroutedMessage],
      sms.smsBatch?.toString(),
      removal.remainingDelayMs,
    )
    await this.markQueuedSmsJobs(queuedJobs)

    const updatedSms = await this.smsModel
      .findById(smsId)
      .populate({
        path: 'device',
        select: '_id brand model buildId enabled name',
      })
      .lean()

    return {
      success: true,
      message: 'Pending SMS rerouted',
      data: updatedSms,
    }
  }

  async resendMessages(
    user: User,
    smsIds: string[] = [],
    targetDeviceId?: string,
  ): Promise<{
    success: true
    resent: number
    skipped: number
    failed: number
    results: Array<{
      smsId: string
      status: 'resent' | 'skipped' | 'failed'
      reason?: string
      targetDeviceId?: string
      smsBatchId?: string
    }>
  }> {
    const uniqueSmsIds = Array.from(
      new Set(
        (smsIds || [])
          .map((smsId) => smsId?.toString?.().trim())
          .filter(
            (smsId): smsId is string =>
              Boolean(smsId && Types.ObjectId.isValid(smsId)),
          ),
      ),
    ).slice(0, 100)

    if (uniqueSmsIds.length === 0) {
      throw new HttpException(
        {
          success: false,
          error: 'At least one valid smsId is required',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    let explicitTargetDevice: any = null
    if (targetDeviceId && targetDeviceId !== 'original') {
      if (!Types.ObjectId.isValid(targetDeviceId)) {
        throw new HttpException(
          {
            success: false,
            error: 'targetDeviceId is invalid',
          },
          HttpStatus.BAD_REQUEST,
        )
      }

      explicitTargetDevice = await this.deviceModel.findById(targetDeviceId)
      if (!explicitTargetDevice?.enabled) {
        throw new HttpException(
          {
            success: false,
            error: 'Target device does not exist or is not enabled',
          },
          HttpStatus.BAD_REQUEST,
        )
      }

      if (
        explicitTargetDevice.user?.toString() !==
        getUserObjectId(user)?.toString()
      ) {
        throw new HttpException(
          {
            success: false,
            error: 'Target device does not belong to this account',
          },
          HttpStatus.FORBIDDEN,
        )
      }
    }

    const messages = await this.smsModel
      .find({
        _id: { $in: uniqueSmsIds },
        ...this.getMessageUserFilter(user),
        type: SMSType.SENT,
      })
      .populate({
        path: 'device',
        select: '_id brand model buildId enabled name',
      })
      .lean()

    const messagesById = new Map(
      (messages || []).map((message: any) => [message._id?.toString(), message]),
    )
    const results: Array<{
      smsId: string
      status: 'resent' | 'skipped' | 'failed'
      reason?: string
      targetDeviceId?: string
      smsBatchId?: string
    }> = []

    for (const smsId of uniqueSmsIds) {
      const original = messagesById.get(smsId)
      if (!original) {
        results.push({
          smsId,
          status: 'skipped',
          reason: 'SMS was not found or is not an outbound message for this account.',
        })
        continue
      }

      const normalizedStatus = String(original.status || '').toLowerCase()
      if ((RESENDABLE_BLOCKED_STATUSES as readonly string[]).includes(normalizedStatus)) {
        results.push({
          smsId,
          status: 'skipped',
          reason: `SMS is still ${normalizedStatus}; cancel or reroute active sends instead of resending them.`,
        })
        continue
      }

      if (!original.message || !original.recipient) {
        results.push({
          smsId,
          status: 'skipped',
          reason: 'SMS does not have both message text and a recipient.',
        })
        continue
      }

      const originalDeviceId =
        original.device?._id?.toString?.() || original.device?.toString?.()
      const sendDeviceId = explicitTargetDevice
        ? explicitTargetDevice._id.toString()
        : originalDeviceId

      if (!sendDeviceId) {
        results.push({
          smsId,
          status: 'failed',
          reason: 'Original device is missing. Choose another enabled device.',
        })
        continue
      }

      try {
        const resendResult = await this.sendSMS(sendDeviceId, {
          message: original.message,
          recipients: [original.recipient],
          smsBody: original.message,
          receivers: [original.recipient],
          ...(original.simSubscriptionId !== undefined && {
            simSubscriptionId: original.simSubscriptionId,
          }),
        } as SendSMSInputDTO)

        results.push({
          smsId,
          status: 'resent',
          targetDeviceId: sendDeviceId,
          smsBatchId: resendResult?.smsBatchId?.toString?.(),
        })
      } catch (error) {
        const response = (error as any)?.response
        results.push({
          smsId,
          status: 'failed',
          targetDeviceId: sendDeviceId,
          reason:
            response?.error ||
            response?.message ||
            (error as any)?.message ||
            'Unable to resend SMS',
        })
      }
    }

    const resent = results.filter((result) => result.status === 'resent').length
    const skipped = results.filter((result) => result.status === 'skipped').length
    const failed = results.filter((result) => result.status === 'failed').length

    return {
      success: true,
      resent,
      skipped,
      failed,
      results,
    }
  }

  async deleteMessage(
    smsId: string,
    user: User,
  ): Promise<{ success: true; deleted: 1; smsId: string }> {
    if (!Types.ObjectId.isValid(smsId)) {
      throw new HttpException(
        {
          success: false,
          error: 'smsId is invalid',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const sms = await this.assertMessageBelongsToUser(smsId, user)
    const status = String(sms.status || '').toLowerCase()
    if (DEVICE_IN_FLIGHT_STATUSES.includes(status as any)) {
      throw new HttpException(
        {
          success: false,
          error: `Active ${status} SMS cannot be deleted. Cancel it before deleting the record.`,
        },
        HttpStatus.CONFLICT,
      )
    }

    const result = await this.smsModel.deleteOne({
      _id: sms._id,
      ...this.getMessageUserFilter(user),
      status: { $nin: DEVICE_IN_FLIGHT_STATUSES },
    })
    const deleted = (result as any).deletedCount || (result as any).n || 0
    if (deleted !== 1) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS could not be deleted because its state changed. Refresh and try again.',
        },
        HttpStatus.CONFLICT,
      )
    }

    await this.deleteOrphanedMessageBatches(
      sms.smsBatch ? [sms.smsBatch] : [],
      user,
    )

    return { success: true, deleted: 1, smsId }
  }

  async deleteMessages(
    user: User,
    smsIds: string[] = [],
  ): Promise<{
    success: true
    requested: number
    deleted: number
    skippedActive: number
    notFoundOrNotOwned: number
  }> {
    const uniqueSmsIds = Array.from(
      new Set(
        (smsIds || [])
          .map((smsId) => smsId?.toString?.().trim())
          .filter(
            (smsId): smsId is string =>
              Boolean(smsId && Types.ObjectId.isValid(smsId)),
          ),
      ),
    ).slice(0, 100)

    if (uniqueSmsIds.length === 0) {
      throw new HttpException(
        {
          success: false,
          error: 'At least one valid smsId is required',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const ownedQuery = {
      _id: { $in: uniqueSmsIds },
      ...this.getMessageUserFilter(user),
    }
    const deletableQuery = {
      ...ownedQuery,
      status: { $nin: DEVICE_IN_FLIGHT_STATUSES },
    }
    const batchIds = await this.getMessageBatchIds(deletableQuery)
    const [skippedActive, result] = await Promise.all([
      this.smsModel.countDocuments({
        ...ownedQuery,
        status: { $in: DEVICE_IN_FLIGHT_STATUSES },
      }),
      this.smsModel.deleteMany(deletableQuery),
    ])
    const deleted = (result as any).deletedCount || (result as any).n || 0
    await this.deleteOrphanedMessageBatches(batchIds, user)

    return {
      success: true,
      requested: uniqueSmsIds.length,
      deleted,
      skippedActive,
      notFoundOrNotOwned: Math.max(
        0,
        uniqueSmsIds.length - deleted - skippedActive,
      ),
    }
  }

  async deleteMessageHistory(
    user: User,
    params: MessageListParams = {},
  ): Promise<{ success: true; deleted: number; skippedActive: number }> {
    const deviceFilterValue = this.getDeviceFilterValue(params.deviceId)
    const baseQuery: any = {
      ...this.getMessageUserFilter(user),
    }

    if (deviceFilterValue) {
      baseQuery.device = deviceFilterValue
    }
    if (params.type === 'sent') {
      baseQuery.type = SMSType.SENT
    } else if (params.type === 'received') {
      baseQuery.type = SMSType.RECEIVED
    }

    const dateFilter = this.getSortableDateFilter(params)
    if (dateFilter) {
      Object.assign(baseQuery, dateFilter)
    }

    const searchFilter = this.buildMessageSearchFilter(params.search)
    if (searchFilter) {
      Object.assign(baseQuery, searchFilter)
    }

    let deleteQuery: any = {
      ...baseQuery,
      status: { $nin: DEVICE_IN_FLIGHT_STATUSES },
    }
    let skippedActiveQuery: any = {
      ...baseQuery,
      status: { $in: DEVICE_IN_FLIGHT_STATUSES },
    }

    if (params.status && params.status !== 'all') {
      if (DEVICE_IN_FLIGHT_STATUSES.includes(params.status as any)) {
        deleteQuery = { ...baseQuery, status: '__never_delete_active_status__' }
        skippedActiveQuery = { ...baseQuery, status: params.status }
      } else {
        deleteQuery = { ...baseQuery, status: params.status }
        skippedActiveQuery = {
          ...baseQuery,
          status: { $in: DEVICE_IN_FLIGHT_STATUSES },
        }
      }
    }

    const batchIds = await this.getMessageBatchIds(deleteQuery)
    const [skippedActive, result] = await Promise.all([
      this.smsModel.countDocuments(skippedActiveQuery),
      this.smsModel.deleteMany(deleteQuery),
    ])
    await this.deleteOrphanedMessageBatches(batchIds, user)

    return {
      success: true,
      deleted: (result as any).deletedCount || (result as any).n || 0,
      skippedActive,
    }
  }

  async updateSMSStatus(deviceId: string, dto: UpdateSMSStatusDTO): Promise<any> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          success: false,
          error: 'Device not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    const sms = await this.smsModel.findById(dto.smsId)

    if (!sms) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    // Verify the SMS belongs to this device, or was actually handed to it on an
    // earlier attempt. A reassignment (lease reclaim / failover) must not throw
    // away the real handset outcome — otherwise the row stays `dispatched`
    // forever and gets re-sent.
    const attemptedDeviceIds: string[] = (
      ((sms.metadata as any)?.dispatchAttempts || []) as any[]
    )
      .map((attempt) => String(attempt?.deviceId || ''))
      .filter(Boolean)
    const ownsSms = sms.device?.toString() === deviceId
    const attemptedSms = attemptedDeviceIds.includes(deviceId)

    if (!ownsSms && !attemptedSms) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS does not belong to this device',
        },
        HttpStatus.FORBIDDEN,
      )
    }

    let normalizedStatus = String(dto.status || '').toLowerCase()
    // Delivery-receipt issues are not send failures — keep as delivered if already sent
    if (normalizedStatus === 'delivery_failed') {
      if (['sent', 'delivered'].includes(String(sms.status).toLowerCase())) {
        normalizedStatus = 'delivered'
      } else {
        normalizedStatus = 'sent'
      }
    }

    const currentStatus = String(sms.status || '').toLowerCase()
    const terminalSuccess = ['delivered']
    const rank: Record<string, number> = {
      pending: 0,
      dispatched: 1,
      sent: 2,
      delivered: 3,
      failed: 2,
      unknown: 1,
      canceled: 3,
    }

    // Never regress a successful delivery
    if (terminalSuccess.includes(currentStatus) && normalizedStatus !== 'delivered') {
      return {
        success: true,
        message: 'SMS already delivered; ignoring later status',
        ignored: true,
      }
    }

    // Don't overwrite canceled
    if (currentStatus === 'canceled') {
      return {
        success: true,
        message: 'SMS already canceled; ignoring later status',
        ignored: true,
      }
    }

    // A stale device reporting failure must not disturb the attempt that now
    // owns the SMS — only remember that this device could not send it.
    if (normalizedStatus === 'failed' && !ownsSms) {
      await this.smsModel.findByIdAndUpdate(dto.smsId, {
        $addToSet: { excludedDeviceIds: new Types.ObjectId(deviceId) },
        $set: {
          'metadata.staleDeviceFailure': {
            at: new Date(),
            deviceId,
            errorCode: dto.errorCode,
            errorMessage: dto.errorMessage,
          },
        },
      })
      return {
        success: true,
        message:
          'Failure recorded for a device that no longer owns this SMS; current attempt untouched',
        ignored: true,
      }
    }

    // Immediate multi-device failover on carrier/device send failure
    if (normalizedStatus === 'failed') {
      const failover = await this.smsOutboxService.handleSendFailureAndFailover(
        dto.smsId,
        deviceId,
        dto.errorCode,
        dto.errorMessage || 'Device reported send failure',
      )

      // If re-dispatched to another device, don't leave status as failed
      if (failover?.status === 'dispatched' || failover?.status === 'pending') {
        return {
          success: true,
          message: 'Send failed on this device; SMS requeued to free device',
          failover,
        }
      }

      // Terminal failure after attempts exhausted / expired
      const updatedSms = await this.smsModel.findById(dto.smsId)
      try {
        this.webhookService.deliverNotification({
          sms: updatedSms,
          user: device.user,
          event: WebhookEvent.MESSAGE_FAILED,
        })
      } catch (error) {
        console.error('Failed to trigger webhook event:', error)
      }

      // Device is free — pull more work
      this.smsOutboxService
        .notifyWorkAvailable(device.user)
        .catch(() => undefined)

      return {
        success: true,
        message: 'SMS marked failed after failover exhausted',
        failover,
      }
    }

    // Don't regress status rank (e.g. sent → dispatched)
    if (
      rank[normalizedStatus] !== undefined &&
      rank[currentStatus] !== undefined &&
      rank[normalizedStatus] < rank[currentStatus] &&
      normalizedStatus !== currentStatus
    ) {
      return {
        success: true,
        message: `Ignoring status regression ${currentStatus} → ${normalizedStatus}`,
        ignored: true,
      }
    }

    const updateData: any = {
      status: normalizedStatus,
    }

    // The handset that actually sent it is the device of record.
    if (!ownsSms && ['sent', 'delivered'].includes(normalizedStatus)) {
      updateData.device = new Types.ObjectId(deviceId)
      updateData['metadata.reportedByPreviousAttempt'] = {
        at: new Date(),
        deviceId,
      }
    }

    if (normalizedStatus === 'sent' && dto.sentAtInMillis) {
      updateData.sentAt = new Date(dto.sentAtInMillis)
    } else if (normalizedStatus === 'delivered') {
      if (dto.deliveredAtInMillis) {
        updateData.deliveredAt = new Date(dto.deliveredAtInMillis)
      }
      if (!sms.sentAt) {
        updateData.sentAt = new Date(dto.deliveredAtInMillis || Date.now())
      }
    }

    const updateOps: any = { $set: updateData }
    if (['sent', 'delivered'].includes(normalizedStatus)) {
      updateOps.$unset = { leasedUntil: '', leasedAt: '' }
    }

    const updatedSms = await this.smsModel.findByIdAndUpdate(
      dto.smsId,
      updateOps,
      { new: true },
    )

    if (dto.smsBatchId) {
      const allSmsInBatch = await this.smsModel.find({ smsBatch: dto.smsBatchId })
      const allHaveSameStatus = allSmsInBatch.every(
        (row) => String(row.status).toLowerCase() === normalizedStatus,
      )

      if (allHaveSameStatus) {
        const smsBatchStatus =
          normalizedStatus === 'failed' ? 'failed' : 'completed'
        await this.smsBatchModel.findByIdAndUpdate(dto.smsBatchId, {
          $set: { status: smsBatchStatus },
        })
      }
    }

    try {
      let event: WebhookEvent
      switch (normalizedStatus) {
        case 'sent':
          event = WebhookEvent.MESSAGE_SENT
          break
        case 'delivered':
          event = WebhookEvent.MESSAGE_DELIVERED
          break
        case 'failed':
          event = WebhookEvent.MESSAGE_FAILED
          break
        case 'received':
          event = WebhookEvent.MESSAGE_RECEIVED
          break
        default:
          event = WebhookEvent.UNKNOWN_STATE
      }
      this.webhookService.deliverNotification({
        sms: updatedSms,
        user: device.user,
        event,
      })
    } catch (error) {
      console.error('Failed to trigger webhook event:', error)
    }

    // Free capacity — wake outbox for more work
    if (['sent', 'delivered'].includes(normalizedStatus)) {
      this.smsOutboxService.dispatchWaitingOutbox(10).catch(() => undefined)
    }

    return {
      success: true,
      message: 'SMS status updated successfully',
    }
  }

  async claimOutboxForDevice(deviceId: string, limit = 5) {
    const device = await this.deviceModel.findById(deviceId)
    if (!device?.enabled) {
      throw new HttpException(
        { success: false, error: 'Device not found or disabled' },
        HttpStatus.BAD_REQUEST,
      )
    }
    return this.smsOutboxService.claimForDevice(deviceId, limit)
  }

  async getStatsForUser(user: User) {
    const devices = await this.deviceModel.find({ user: user._id })
    const apiKeys = await this.authService.getUserApiKeys(user)

    const totalSentSMSCount = devices.reduce((acc, device) => {
      return acc + (device.sentSMSCount || 0)
    }, 0)

    const totalReceivedSMSCount = devices.reduce((acc, device) => {
      return acc + (device.receivedSMSCount || 0)
    }, 0)

    const totalDeviceCount = devices.length
    const totalApiKeyCount = apiKeys.length

    return {
      totalSentSMSCount,
      totalReceivedSMSCount,
      totalDeviceCount,
      totalApiKeyCount,
    }
  }

  private getRecipientsPreview(recipients: string[]): string {
    if (recipients.length === 0) {
      return null
    } else if (recipients.length === 1) {
      return recipients[0]
    } else if (recipients.length === 2) {
      return `${recipients[0]} and ${recipients[1]}`
    } else if (recipients.length === 3) {
      return `${recipients[0]}, ${recipients[1]}, and ${recipients[2]}`
    } else {
      return `${recipients[0]}, ${recipients[1]}, and ${
        recipients.length - 2
      } others`
    }
  }

  async getSMSById(smsId: string): Promise<any> {

    const sms = await this.smsModel.findById(smsId);

    if (!sms) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS not found',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return sms;
  }

  async getSmsBatchById(smsBatchId: string): Promise<any> {

    const smsBatch = await this.smsBatchModel.findById(smsBatchId);

    if (!smsBatch) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS batch not found',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // Find all SMS messages that belong to this batch
    const smsMessages = await this.smsModel.find({ 
      smsBatch: new Types.ObjectId(smsBatchId),
      device: smsBatch.device
    });

    // Return both the batch and its SMS messages
    return {
      batch: smsBatch,
      messages: smsMessages
    };
  }

  async heartbeat(
    deviceId: string,
    input: HeartbeatInputDTO,
  ): Promise<HeartbeatResponseDTO> {
    const device = await this.deviceModel.findById(deviceId)

    if (!device) {
      throw new HttpException(
        {
          success: false,
          error: 'Device not found',
        },
        HttpStatus.NOT_FOUND,
      )
    }

    const now = new Date()
    const updateData: any = {
      lastHeartbeat: now,
    }

    let fcmTokenUpdated = false

    // Update FCM token if provided and different
    if (input.fcmToken && input.fcmToken !== device.fcmToken) {
      updateData.fcmToken = input.fcmToken
      updateData.fcmTokenUpdatedAt = now
      updateData.fcmTokenInvalidatedAt = undefined
      updateData.fcmTokenInvalidReason = undefined
      fcmTokenUpdated = true
    }

    // Update receiveSMSEnabled if provided and different
    if (
      input.receiveSMSEnabled !== undefined &&
      input.receiveSMSEnabled !== device.receiveSMSEnabled
    ) {
      updateData.receiveSMSEnabled = input.receiveSMSEnabled
    }

    // Update smsSendDelaySeconds if provided (clamp 0-3600)
    if (input.smsSendDelaySeconds !== undefined) {
      const clamped = Math.min(
        3600,
        Math.max(0, Math.floor(Number(input.smsSendDelaySeconds))),
      )
      updateData.smsSendDelaySeconds = clamped
    }

    // Update batteryInfo if provided
    if (input.batteryPercentage !== undefined || input.isCharging !== undefined) {
      if (input.batteryPercentage !== undefined) {
        updateData['batteryInfo.percentage'] = input.batteryPercentage
      }
      if (input.isCharging !== undefined) {
        updateData['batteryInfo.isCharging'] = input.isCharging
      }
      updateData['batteryInfo.lastUpdated'] = now
    }

    // Update networkInfo if provided
    if (input.networkType !== undefined) {
      updateData['networkInfo.networkType'] = input.networkType
      updateData['networkInfo.lastUpdated'] = now
    }

    // Update appVersionInfo if provided
    if (input.appVersionName !== undefined || input.appVersionCode !== undefined) {
      if (input.appVersionName !== undefined) {
        updateData['appVersionInfo.versionName'] = input.appVersionName
      }
      if (input.appVersionCode !== undefined) {
        updateData['appVersionInfo.versionCode'] = input.appVersionCode
      }
      updateData['appVersionInfo.lastUpdated'] = now
    }

    // Update deviceUptimeInfo if provided
    if (input.deviceUptimeMillis !== undefined) {
      updateData['deviceUptimeInfo.uptimeMillis'] = input.deviceUptimeMillis
      updateData['deviceUptimeInfo.lastUpdated'] = now
    }

    // Update systemInfo if timezone or locale provided
    if (input.timezone !== undefined || input.locale !== undefined) {
      if (input.timezone !== undefined) {
        updateData['systemInfo.timezone'] = input.timezone
      }
      if (input.locale !== undefined) {
        updateData['systemInfo.locale'] = input.locale
      }
      updateData['systemInfo.lastUpdated'] = now
    }

    // Update simInfo if provided
    if (input.simInfo !== undefined) {
      updateData.simInfo = {
        ...input.simInfo,
        lastUpdated: input.simInfo.lastUpdated || now,
      }
    }

    // Update device with all changes
    await this.deviceModel.findByIdAndUpdate(deviceId, {
      $set: updateData,
    })

    if (fcmTokenUpdated) {
      await this.detachFcmTokenFromOtherDevices(
        device.user,
        device._id,
        input.fcmToken,
      )
    }

    // Fetch updated device to get current name
    const updatedDevice = await this.deviceModel.findById(deviceId)

    // Device is alive — only dispatch when gateway is enabled on server.
    // Never claim on behalf of the device here: the heartbeat response cannot
    // carry SMS payloads, so a claim would mark messages `dispatched` with no
    // handset holding them. The device pulls its own work via /claim-outbox.
    let outboxPending = 0
    const gatewayEnabled = updatedDevice?.enabled !== false
    if (gatewayEnabled) {
      try {
        await this.smsOutboxService.dispatchWaitingOutbox(20)
        outboxPending = await this.smsOutboxService.countWaitingOutbox(
          device.user,
        )
        if (outboxPending > 0) {
          await this.smsOutboxService.notifyWorkAvailable(device.user)
        }
      } catch (e) {
        console.error('heartbeat outbox dispatch failed', e)
      }
    }

    return {
      success: true,
      fcmTokenUpdated,
      lastHeartbeat: now,
      name: updatedDevice?.name,
      outboxPending,
      enabled: gatewayEnabled,
    }
  }

  /**
   * Push remote gateway config to the phone so web enable/disable updates the app UI ASAP.
   */
  private async pushDeviceConfig(device: any): Promise<void> {
    if (!device?.fcmToken || device.fcmTokenInvalidatedAt) {
      return
    }
    try {
      await firebaseAdmin.messaging().send({
        data: {
          type: 'device_config',
          enabled: device.enabled ? 'true' : 'false',
        },
        token: device.fcmToken,
        android: { priority: 'high' },
      })
    } catch (e: any) {
      console.warn(
        `pushDeviceConfig failed for ${device._id}: ${e?.message || e}`,
      )
    }
  }
}
