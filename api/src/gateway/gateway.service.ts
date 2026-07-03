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

type MessageListParams = {
  page?: number
  limit?: number
  type?: string
  status?: string
  deviceId?: string
  search?: string
  from?: string
  to?: string
  includeHidden?: boolean
}

type QueueRehydrateResult = {
  jobId: string
  smsIds: string[]
  delayMs?: number
}

const DEVICE_SEND_COOLDOWN_LIMIT = 5
const DEVICE_SEND_COOLDOWN_HOURS = 5
const DEVICE_ACTIVE_SEND_STATUSES = ['pending', 'dispatched']
const DEVICE_FAILED_SEND_STATUSES = ['failed', 'unknown']
const RESENDABLE_BLOCKED_STATUSES = ['pending', 'dispatched']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getUserObjectId(user: User): any {
  return (user as any)?._id || (user as any)?.id
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
  ) {}

  private buildVisibleMessageFilter(includeHidden = false): Record<string, any> {
    return includeHidden ? {} : { hiddenAt: { $exists: false } }
  }

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
    cooldownHours: number
  }> {
    const deviceId = this.getDeviceIdString(device)
    const userId = this.getDeviceUserId(device)
    const cooldownSince = new Date(
      Date.now() - DEVICE_SEND_COOLDOWN_HOURS * 60 * 60 * 1000,
    )

    const baseQuery = {
      ...(userId ? { user: userId } : {}),
      device: deviceId,
      type: SMSType.SENT,
    }

    const [activeCountRaw, recentIssueCountRaw] = await Promise.all([
      this.smsModel.countDocuments({
        ...baseQuery,
        status: { $in: DEVICE_ACTIVE_SEND_STATUSES },
      }),
      this.smsModel.countDocuments({
        ...baseQuery,
        status: { $in: DEVICE_FAILED_SEND_STATUSES },
        $or: [
          { updatedAt: { $gte: cooldownSince } },
          { failedAt: { $gte: cooldownSince } },
          { createdAt: { $gte: cooldownSince } },
        ],
      }),
    ])

    return {
      activeCount: Number(activeCountRaw) || 0,
      recentIssueCount: Number(recentIssueCountRaw) || 0,
      limit: DEVICE_SEND_COOLDOWN_LIMIT,
      cooldownHours: DEVICE_SEND_COOLDOWN_HOURS,
    }
  }

  private async assertDeviceCanAcceptSend(device: any): Promise<void> {
    const health = await this.getDeviceSendHealth(device)
    const activeBlocked = health.activeCount >= DEVICE_SEND_COOLDOWN_LIMIT
    const issueBlocked = health.recentIssueCount >= DEVICE_SEND_COOLDOWN_LIMIT

    if (!activeBlocked && !issueBlocked) {
      return
    }

    const reason = activeBlocked
      ? `Device already has ${health.activeCount} pending/dispatched SMS. Cancel, reroute, or let those finish before sending more to this device.`
      : `Device has ${health.recentIssueCount} failed/unknown SMS in the last ${DEVICE_SEND_COOLDOWN_HOURS} hours. It is paused for safety.`

    throw new HttpException(
      {
        success: false,
        error: reason,
        message: reason,
        deviceId: this.getDeviceIdString(device),
        activePendingOrDispatched: health.activeCount,
        recentFailedOrUnknown: health.recentIssueCount,
        cooldownLimit: health.limit,
        cooldownHours: health.cooldownHours,
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
    // Mongoose 9.6's strict types collide on the reserved `model` field name
    // (it expects Mongoose's `Model<any>` shape, not the device's `model`
    // schema field). Cast the filter to bypass the type check; runtime
    // behavior is unchanged.
    const deviceFilter = {
      user: user._id,
      model: input.model,
      buildId: input.buildId,
    } as any
    const device = await this.deviceModel.findOne(deviceFilter)

    const now = new Date()
    const deviceData: any = { ...input, user }
    
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

    if (device && device.appVersionCode <= 11) {
      // re-enable path: updateDevice enforces the device limit on the
      // disabled -> enabled transition
      return await this.updateDevice(device._id.toString(), {
        ...deviceData,
        enabled: true,
      })
    } else {
      await this.assertDeviceLimitNotReached(user._id)
      deviceData.enabled = input.enabled ?? true
      return await this.deviceModel.create(deviceData)
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
    
    return await this.deviceModel.findByIdAndUpdate(
      deviceId,
      { $set: updateData },
      { new: true },
    )
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

    // Calculate delay from scheduledAt if provided
    const delayMs = this.calculateDelayFromScheduledAt(smsData.scheduledAt)

    // Validate that scheduling requires queue to be enabled
    if (delayMs !== undefined && !this.smsQueueService.isQueueEnabled()) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS scheduling requires queue to be enabled',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.assertDeviceCanAcceptSend(device)

    await this.billingService.canPerformAction(
      device.user.toString(),
      'send_sms',
      recipients.length,
    )

    // TODO: Implement a queue to send the SMS if recipients are too many

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

    const fcmMessages: Message[] = []

    for (let recipient of recipients) {
      recipient = recipient.replace(/\s+/g, "")
      const sms = await this.smsModel.create({
        user: device.user,
        device: device._id,
        smsBatch: smsBatch._id,
        message: message,
        type: SMSType.SENT,
        recipient,
        requestedAt: new Date(),
        status: 'pending',
        ...(smsData.simSubscriptionId !== undefined && {
          simSubscriptionId: smsData.simSubscriptionId,
        }),
      })
      const updatedSMSData = {
        smsId: sms._id,
        smsBatchId: smsBatch._id,
        deviceId: device._id.toString(),
        targetDeviceId: device._id.toString(),
        message,
        recipients: [recipient],
        ...(smsData.simSubscriptionId !== undefined && {
          simSubscriptionId: smsData.simSubscriptionId,
        }),

        // Legacy fields to be removed in the future
        smsBody: message,
        receivers: [recipient],
      }
      const stringifiedSMSData = JSON.stringify(updatedSMSData)

      const fcmMessage: Message = {
        data: {
          smsData: stringifiedSMSData,
          targetDeviceId: device._id.toString(),
        },
        token: device.fcmToken,
        android: {
          priority: 'high',
        },
      }
      fcmMessages.push(fcmMessage)
    }

    // Check if we should use the queue
    if (this.smsQueueService.isQueueEnabled()) {
      try {
        // Update batch status to processing
        await this.smsBatchModel.findByIdAndUpdate(smsBatch._id, {
          $set: { status: 'processing' },
        })

        // Add to queue
        const queuedJobs = await this.smsQueueService.addSendSmsJob(
          deviceId,
          fcmMessages,
          smsBatch._id.toString(),
          delayMs,
        )
        await this.markQueuedSmsJobs(queuedJobs)

        return {
          success: true,
          message: 'SMS added to queue for processing',
          smsBatchId: smsBatch._id,
          recipientCount: recipients.length,
        }
      } catch (e) {
        // Update batch status to failed
        await this.smsBatchModel.findByIdAndUpdate(smsBatch._id, {
          $set: { status: 'failed', error: e.message },
        })

        // Update all SMS in batch to failed
        await this.smsModel.updateMany(
          { smsBatch: smsBatch._id },
          { $set: { status: 'failed', error: e.message } },
        )

        throw new HttpException(
          {
            success: false,
            error: 'Failed to add SMS to queue',
            additionalInfo: e,
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        )
      }
    }

    try {
      const response = await firebaseAdmin.messaging().sendEach(fcmMessages)

      console.log(response)

      if (response.successCount === 0) {
        throw new HttpException(
          {
            success: false,
            error: 'Failed to send SMS',
            additionalInfo: response,
          },
          HttpStatus.BAD_REQUEST,
        )
      }

      this.deviceModel
        .findByIdAndUpdate(deviceId, {
          $inc: { sentSMSCount: response.successCount },
        })
        .exec()
        .catch((e) => {
          console.log('Failed to update sentSMSCount')
          console.log(e)
        })

      this.smsBatchModel
        .findByIdAndUpdate(smsBatch._id, {
          $set: { status: 'completed' },
        })
        .exec()
        .catch((e) => {
          console.error('failed to update sms batch status to completed')
        })

      return response
    } catch (e) {
      this.smsBatchModel
        .findByIdAndUpdate(smsBatch._id, {
          $set: { status: 'failed', error: e.message },
        })
        .exec()
        .catch((e) => {
          console.error('failed to update sms batch status to failed')
        })
      throw new HttpException(
        {
          success: false,
          error: 'Failed to send SMS',
          additionalInfo: e,
        },
        HttpStatus.BAD_REQUEST,
      )
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

    await this.assertDeviceCanAcceptSend(device)

    await this.billingService.canPerformAction(
      device.user.toString(),
      'bulk_send_sms',
      body.messages.map((m) => m.recipients).flat().length,
    )

    // Check if any message has scheduledAt and validate queue is enabled
    const hasScheduledMessages = body.messages.some((m) => m.scheduledAt)
    if (hasScheduledMessages && !this.smsQueueService.isQueueEnabled()) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS scheduling requires queue to be enabled',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const { messageTemplate, messages } = body

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

    // Track FCM messages with their calculated delays for grouping
    const fcmMessagesWithDelays: Array<{ message: Message; delayMs?: number }> = []
    const smsDocumentsToInsert: Array<Record<string, any>> = []
    const smsToFcmMetadata: Array<{
      recipient: string
      message: string
      simSubscriptionId?: number
      delayMs?: number
    }> = []

    for (const smsData of messages) {
      const message = smsData.message
      const recipients = smsData.recipients

      if (!message) {
        continue
      }

      if (!Array.isArray(recipients) || recipients.length === 0) {
        continue
      }

      // Calculate delay for this message's scheduledAt
      const delayMs = this.calculateDelayFromScheduledAt(smsData.scheduledAt)

      for (let recipient of recipients) {
        recipient = recipient.replace(/\s+/g, "")
        smsDocumentsToInsert.push({
          user: device.user,
          device: device._id,
          smsBatch: smsBatch._id,
          message: message,
          type: SMSType.SENT,
          recipient,
          requestedAt: new Date(),
          status: 'pending',
          ...(smsData.simSubscriptionId !== undefined && {
            simSubscriptionId: smsData.simSubscriptionId,
          }),
        })
        smsToFcmMetadata.push({
          recipient,
          message,
          ...(smsData.simSubscriptionId !== undefined && {
            simSubscriptionId: smsData.simSubscriptionId,
          }),
          delayMs,
        })
      }
    }

    const insertChunkSize = 500
    const insertedSmsDocs: any[] = []
    const hasInsertMany = typeof (this.smsModel as any).insertMany === 'function'
    for (let i = 0; i < smsDocumentsToInsert.length; i += insertChunkSize) {
      const chunk = smsDocumentsToInsert.slice(i, i + insertChunkSize)
      if (hasInsertMany) {
        const insertedChunk = await (this.smsModel as any).insertMany(chunk, { ordered: true })
        insertedSmsDocs.push(...insertedChunk)
        continue
      }

      // Fallback for mocked/non-standard models that don't expose insertMany
      for (const smsDocument of chunk) {
        const createdSmsDoc = await this.smsModel.create(smsDocument)
        insertedSmsDocs.push(createdSmsDoc)
      }
    }

    if (insertedSmsDocs.length !== smsToFcmMetadata.length) {
      throw new HttpException(
        {
          success: false,
          error: 'Failed to map created SMS records to queue payload',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }

    for (let i = 0; i < insertedSmsDocs.length; i++) {
      const sms = insertedSmsDocs[i]
      const metadata = smsToFcmMetadata[i]
      const updatedSMSData = {
        smsId: sms._id,
        smsBatchId: smsBatch._id,
        deviceId: device._id.toString(),
        targetDeviceId: device._id.toString(),
        message: metadata.message,
        recipients: [metadata.recipient],
        ...(metadata.simSubscriptionId !== undefined && {
          simSubscriptionId: metadata.simSubscriptionId,
        }),

        // Legacy fields to be removed in the future
        smsBody: metadata.message,
        receivers: [metadata.recipient],
      }
      const stringifiedSMSData = JSON.stringify(updatedSMSData)

      const fcmMessage: Message = {
        data: {
          smsData: stringifiedSMSData,
          targetDeviceId: device._id.toString(),
        },
        token: device.fcmToken,
        android: {
          priority: 'high',
        },
      }
      fcmMessagesWithDelays.push({ message: fcmMessage, delayMs: metadata.delayMs })
    }

    // Check if we should use the queue
    if (this.smsQueueService.isQueueEnabled()) {
      try {
        // Group messages by delay (undefined delay means immediate, group together)
        const messagesByDelay = new Map<number | undefined, Message[]>()
        for (const { message, delayMs } of fcmMessagesWithDelays) {
          const delayKey = delayMs !== undefined ? delayMs : undefined
          if (!messagesByDelay.has(delayKey)) {
            messagesByDelay.set(delayKey, [])
          }
          messagesByDelay.get(delayKey)!.push(message)
        }

        // Queue each group with its respective delay
        for (const [delayMs, messages] of messagesByDelay.entries()) {
          const queuedJobs = await this.smsQueueService.addSendSmsJob(
            deviceId,
            messages,
            smsBatch._id.toString(),
            delayMs,
          )
          await this.markQueuedSmsJobs(queuedJobs)
        }

        return {
          success: true,
          message: 'Bulk SMS added to queue for processing',
          smsBatchId: smsBatch._id,
          recipientCount: messages.map((m) => m.recipients).flat().length,
        }
      } catch (e) {
        // Update batch status to failed
        await this.smsBatchModel.findByIdAndUpdate(smsBatch._id, {
          $set: {
            status: 'failed',
            error: e.message,
            successCount: 0,
            failureCount: fcmMessagesWithDelays.length,
          },
        })

        // Update all SMS in batch to failed
        await this.smsModel.updateMany(
          { smsBatch: smsBatch._id },
          { $set: { status: 'failed', error: e.message } },
        )

        throw new HttpException(
          {
            success: false,
            error: 'Failed to add bulk SMS to queue',
            additionalInfo: e,
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        )
      }
    }

    // For non-queue path, convert back to simple array
    const fcmMessages = fcmMessagesWithDelays.map(({ message }) => message)
    const fcmMessagesBatches = fcmMessages.map((m) => [m])
    const fcmResponses: BatchResponse[] = []

    for (const batch of fcmMessagesBatches) {
      try {
        const response = await firebaseAdmin.messaging().sendEach(batch)

        console.log(response)
        fcmResponses.push(response)

        this.deviceModel
          .findByIdAndUpdate(deviceId, {
            $inc: { sentSMSCount: response.successCount },
          })
          .exec()
          .catch((e) => {
            console.log('Failed to update sentSMSCount')
            console.log(e)
          })

        this.smsBatchModel
          .findByIdAndUpdate(smsBatch._id, {
            $set: { status: 'completed' },
          })
          .exec()
          .catch((e) => {
            console.error('failed to update sms batch status to completed')
          })
      } catch (e) {
        console.log('Failed to send SMS: FCM')
        console.log(e)

        this.smsBatchModel
          .findByIdAndUpdate(smsBatch._id, {
            $set: { status: 'failed', error: e.message },
          })
          .exec()
          .catch((e) => {
            console.error('failed to update sms batch status to failed')
          })
      }
    }

    const successCount = fcmResponses.reduce(
      (acc, m) => acc + m.successCount,
      0,
    )
    const failureCount = fcmResponses.reduce(
      (acc, m) => acc + m.failureCount,
      0,
    )
    const response = {
      success: successCount > 0,
      successCount,
      failureCount,
      fcmResponses,
    }
    return response
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
      ...this.buildVisibleMessageFilter(),
    })

    // @ts-ignore
    const data = await this.smsModel
      .find(
        {
          device: device._id,
          type: SMSType.RECEIVED,
          ...this.buildVisibleMessageFilter(),
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
    const query: any = { device: device._id, ...this.buildVisibleMessageFilter() }

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

    const query: any = {
      ...this.getMessageUserFilter(user),
      ...this.buildVisibleMessageFilter(params.includeHidden),
    }

    if (params.deviceId && params.deviceId !== 'all') {
      query.device = params.deviceId
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
      ...this.buildVisibleMessageFilter(params.includeHidden),
      ...(params.deviceId && params.deviceId !== 'all' ? { device: params.deviceId } : {}),
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
        ...this.buildVisibleMessageFilter(false),
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
      if (RESENDABLE_BLOCKED_STATUSES.includes(normalizedStatus)) {
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

  async clearMessageHistory(
    user: User,
    params: MessageListParams = {},
  ): Promise<{ success: true; cleared: number; skippedActive: number }> {
    const baseQuery: any = {
      ...this.getMessageUserFilter(user),
      ...this.buildVisibleMessageFilter(false),
    }

    if (params.deviceId && params.deviceId !== 'all') {
      baseQuery.device = params.deviceId
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

    const activeStatuses = ['pending', 'dispatched']
    let clearQuery: any = { ...baseQuery, status: { $nin: activeStatuses } }
    let skippedActiveQuery: any = { ...baseQuery, status: { $in: activeStatuses } }

    if (params.status && params.status !== 'all') {
      if (activeStatuses.includes(params.status)) {
        clearQuery = { ...baseQuery, status: '__never_clear_active_status__' }
        skippedActiveQuery = { ...baseQuery, status: params.status }
      } else {
        clearQuery = { ...baseQuery, status: params.status }
        skippedActiveQuery = { ...baseQuery, status: { $in: activeStatuses } }
      }
    }

    const [skippedActive, result] = await Promise.all([
      this.smsModel.countDocuments(skippedActiveQuery),
      this.smsModel.updateMany(clearQuery, {
        $set: {
          hiddenAt: new Date(),
          'metadata.clearedFromHistoryAt': new Date(),
        },
      }),
    ])

    return {
      success: true,
      cleared: (result as any).modifiedCount || (result as any).nModified || 0,
      skippedActive,
    }
  }

  async updateSMSStatus(deviceId: string, dto: UpdateSMSStatusDTO): Promise<any> {

    const device = await this.deviceModel.findById(deviceId);
    
    if (!device) {
      throw new HttpException(
        {
          success: false,
          error: 'Device not found',
        },
        HttpStatus.NOT_FOUND,
      );
    }
    
    const sms = await this.smsModel.findById(dto.smsId);
    
    if (!sms) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS not found',
        },
        HttpStatus.NOT_FOUND,
      );
    }
    
    // Verify the SMS belongs to this device
    if (sms.device.toString() !== deviceId) {
      throw new HttpException(
        {
          success: false,
          error: 'SMS does not belong to this device',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    
    // Normalize status to lowercase for comparison
    const normalizedStatus = dto.status.toLowerCase();
    
    const updateData: any = {
      status: normalizedStatus, // Store normalized status
    };
    
    // Update timestamps based on status
    if (normalizedStatus === 'sent' && dto.sentAtInMillis) {
      updateData.sentAt = new Date(dto.sentAtInMillis);
    } else if (normalizedStatus === 'delivered' && dto.deliveredAtInMillis) {
      updateData.deliveredAt = new Date(dto.deliveredAtInMillis);
    } else if (normalizedStatus === 'failed' && dto.failedAtInMillis) {
      updateData.failedAt = new Date(dto.failedAtInMillis);
      updateData.errorCode = dto.errorCode;
      updateData.errorMessage = dto.errorMessage || 'Unknown error';
    }
    
    // Update the SMS
const updatedSms = await this.smsModel.findByIdAndUpdate(
  dto.smsId,
  { $set: updateData },
  { new: true } 
);
    
    // Check if all SMS in batch have the same status, then update batch status
    if (dto.smsBatchId) {
      const smsBatch = await this.smsBatchModel.findById(dto.smsBatchId);
      if (smsBatch) {
        const allSmsInBatch = await this.smsModel.find({ smsBatch: dto.smsBatchId });
        
        // Check if all SMS in batch have the same status (case insensitive)
        const allHaveSameStatus = allSmsInBatch.every(sms => sms.status.toLowerCase() === normalizedStatus);
        
        if (allHaveSameStatus) {
          const smsBatchStatus = normalizedStatus === 'failed' ? 'failed' : 'completed';
          await this.smsBatchModel.findByIdAndUpdate(dto.smsBatchId, { 
            $set: { status: smsBatchStatus } 
          });
        }
      }
    }
    
    // Trigger webhook event for SMS status update
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
      });
    } catch (error) {
      console.error('Failed to trigger webhook event:', error);
    }
    
    return {
      success: true,
      message: 'SMS status updated successfully',
    };
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

    // Fetch updated device to get current name
    const updatedDevice = await this.deviceModel.findById(deviceId)

    return {
      success: true,
      fcmTokenUpdated,
      lastHeartbeat: now,
      name: updatedDevice?.name,
    }
  }
}
