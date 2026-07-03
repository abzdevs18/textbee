import { Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bull'
import { Job, Queue } from 'bull'
import { ConfigService } from '@nestjs/config'
import { Message } from 'firebase-admin/messaging'

type QueuedSmsJob = {
  jobId: string
  smsIds: string[]
  delayMs?: number
}

type RemovedSmsFromJobResult = {
  removed: boolean
  state?: string
  reason?: string
  deviceId?: string
  smsBatchId?: string
  remainingFcmMessages: Message[]
  remainingDelayMs?: number
}

@Injectable()
export class SmsQueueService {
  private readonly logger = new Logger(SmsQueueService.name)
  private readonly useSmsQueue: boolean
  private readonly maxSmsBatchSize: number
  private readonly immediateQueueDelayMs: number

  constructor(
    @InjectQueue('sms') private readonly smsQueue: Queue,
    private readonly configService: ConfigService,
  ) {
    this.useSmsQueue = this.configService.get<boolean>('USE_SMS_QUEUE', false)
    this.maxSmsBatchSize = this.configService.get<number>(
      'MAX_SMS_BATCH_SIZE',
      100,
    )
    this.immediateQueueDelayMs = this.configService.get<number>(
      'SMS_QUEUE_IMMEDIATE_DELAY_MS',
      0,
    )
  }

  /**
   * Check if queue is enabled based on environment variable
   */
  isQueueEnabled(): boolean {
    return this.useSmsQueue
  }

  private extractSmsIds(fcmMessages: Message[]): string[] {
    return fcmMessages
      .map((message) => {
        try {
          const smsData = JSON.parse(message.data?.smsData || '{}')
          return smsData.smsId ? String(smsData.smsId) : null
        } catch (error) {
          this.logger.warn('Unable to parse queued SMS payload metadata')
          return null
        }
      })
      .filter((smsId): smsId is string => !!smsId)
  }

  async addSendSmsJob(
    deviceId: string,
    fcmMessages: Message[],
    smsBatchId: string,
    delayMs?: number,
  ): Promise<QueuedSmsJob[]> {
    // this.logger.debug(`Adding send-sms job for batch ${smsBatchId}`)

    // Split messages into batches of max smsBatchSize messages
    const batches = []
    for (let i = 0; i < fcmMessages.length; i += this.maxSmsBatchSize) {
      batches.push(fcmMessages.slice(i, i + this.maxSmsBatchSize))
    }

    // If delayMs is provided, use it for all batches (scheduled send)
    // Otherwise rely on queue limiter/concurrency and optionally fixed jitter.
    const useScheduledDelay = delayMs !== undefined && delayMs >= 0

    const queuedJobs: QueuedSmsJob[] = []
    for (const batch of batches) {
      const delay = useScheduledDelay ? delayMs : this.immediateQueueDelayMs
      const job = await this.smsQueue.add(
        'send-sms',
        {
          deviceId,
          fcmMessages: batch,
          smsBatchId,
        },
        {
          priority: 1, // TODO: Make this dynamic based on users subscription plan
          attempts: 1,
          delay: delay,
          backoff: {
            type: 'exponential',
            delay: 5000, // 5 seconds
          },
          removeOnComplete: { age: 24 * 3600 }, // 24 hours
          removeOnFail: { age: 72 * 3600 }, // 72 hours
        },
      )
      queuedJobs.push({
        jobId: String(job.id),
        smsIds: this.extractSmsIds(batch),
        delayMs: delay,
      })
    }

    return queuedJobs
  }

  async removeSmsFromWaitingJob(
    queueJobId: string,
    smsId: string,
  ): Promise<RemovedSmsFromJobResult> {
    const job = await this.smsQueue.getJob(queueJobId)

    if (!job) {
      return {
        removed: false,
        reason: 'Queue job not found. The SMS may already have been processed.',
        remainingFcmMessages: [],
      }
    }

    const state = await job.getState()
    if (state !== 'waiting' && state !== 'delayed') {
      return {
        removed: false,
        state,
        reason: `Queue job is already ${state}.`,
        remainingFcmMessages: [],
      }
    }

    const fcmMessages = Array.isArray(job.data?.fcmMessages)
      ? (job.data.fcmMessages as Message[])
      : []
    const remainingFcmMessages: Message[] = []
    let found = false

    for (const fcmMessage of fcmMessages) {
      try {
        const smsData = JSON.parse(fcmMessage.data?.smsData || '{}')
        if (String(smsData.smsId) === String(smsId)) {
          found = true
          continue
        }
      } catch (error) {
        this.logger.warn('Unable to parse queued SMS payload while pruning job')
      }
      remainingFcmMessages.push(fcmMessage)
    }

    if (!found) {
      return {
        removed: false,
        state,
        reason: 'SMS was not found inside the queue job.',
        remainingFcmMessages: [],
      }
    }

    const remainingDelayMs =
      state === 'delayed'
        ? Math.max(0, (Number((job as Job).timestamp) || Date.now()) + (Number(job.opts?.delay) || 0) - Date.now())
        : undefined

    await job.remove()

    return {
      removed: true,
      state,
      deviceId: job.data?.deviceId,
      smsBatchId: job.data?.smsBatchId,
      remainingFcmMessages,
      remainingDelayMs,
    }
  }
}
