import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { SMS } from '../schemas/sms.schema'
import { SMSBatch } from '../schemas/sms-batch.schema'
import { SmsOutboxService } from '../sms-outbox.service'
import { SMSType } from '../sms-type.enum'

@Injectable()
export class SmsStatusUpdateTask {
  private readonly logger = new Logger(SmsStatusUpdateTask.name)

  constructor(
    @InjectModel(SMS.name) private smsModel: Model<SMS>,
    @InjectModel(SMSBatch.name) private smsBatchModel: Model<SMSBatch>,
    private readonly smsOutboxService: SmsOutboxService,
  ) {}

  /**
   * Every minute: hard-cancel SMS older than 2h, reclaim leases, dispatch waiting outbox.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleOutboxMaintenance() {
    try {
      const canceled = await this.smsOutboxService.cancelAllExpired()
      if (canceled > 0) {
        this.logger.log(`Canceled ${canceled} SMS past 2h max age`)
      }

      const reclaimed = await this.smsOutboxService.reclaimExpiredLeases()
      if (reclaimed > 0) {
        this.logger.log(`Reclaimed ${reclaimed} expired SMS leases`)
      }

      const dispatched = await this.smsOutboxService.dispatchWaitingOutbox(100)
      if (dispatched > 0) {
        this.logger.log(`Dispatched ${dispatched} waiting outbox SMS`)
      }
    } catch (error) {
      this.logger.error('Error in outbox maintenance cron', error)
    }
  }

  /**
   * Every 5 minutes: mark stuck dispatched SMS without device response as unknown
   * (only if not already canceled by 2h policy; still within age but silent).
   * Does NOT re-send — outbox lease reclaim handles retries.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handlePendingSmsTimeout() {
    this.logger.log(
      'Running cron job for stale dispatched SMS (20m → unknown fallback)',
    )

    const twentyMinutesAgo = new Date()
    twentyMinutesAgo.setMinutes(twentyMinutesAgo.getMinutes() - 20)

    try {
      // Only dispatched (FCM accepted) with no device callback — not still-pending outbox
      const dispatchedResult = await this.smsModel.updateMany(
        {
          type: SMSType.SENT,
          status: 'dispatched',
          dispatchedAt: { $lt: twentyMinutesAgo },
          $or: [
            { expiresAt: { $gt: new Date() } },
            { expiresAt: { $exists: false } },
          ],
        },
        {
          $set: {
            status: 'unknown',
            errorMessage:
              'No device status after dispatch (20 minutes). Will not auto-resend; use resend if needed.',
          },
          $unset: {
            leasedUntil: '',
            leasedAt: '',
          },
        },
      )
      this.logger.log(
        `Updated ${dispatchedResult.modifiedCount} SMS from dispatched → unknown`,
      )

      // Legacy: pending without expiresAt and very old requestedAt already canceled by cancelAllExpired
      // Mark very old pending without expiresAt that somehow remain
      const pendingResult = await this.smsModel.updateMany(
        {
          type: SMSType.SENT,
          status: 'pending',
          expiresAt: { $exists: false },
          requestedAt: { $lt: twentyMinutesAgo },
        },
        {
          $set: {
            status: 'unknown',
            errorMessage:
              'Legacy pending without expiry timed out after 20 minutes',
          },
        },
      )
      if (pendingResult.modifiedCount > 0) {
        this.logger.log(
          `Updated ${pendingResult.modifiedCount} legacy pending SMS → unknown`,
        )
      }

      const batchResult = await this.smsBatchModel.updateMany(
        {
          status: 'pending',
          createdAt: { $lt: twentyMinutesAgo },
        },
        {
          $set: {
            status: 'unknown',
            error: 'Batch timeout - no completion after 20 minutes',
          },
        },
      )
      this.logger.log(
        `Updated ${batchResult.modifiedCount} SMS batches from pending → unknown`,
      )
    } catch (error) {
      this.logger.error('Error updating stale SMS messages', error)
    }
  }
}
