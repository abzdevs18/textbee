import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import * as firebase from 'firebase-admin'
import { createHash } from 'crypto'
import { Device, DeviceDocument } from './schemas/device.schema'
import { PushNotificationDTO } from './push-notification.dto'

/** General app pushes, delivered independently of the SMS modem/outbox queue. */
@Injectable()
export class PushNotificationService {
  constructor(
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
  ) {}

  async sendToAccount(userId: string, input: PushNotificationDTO) {
    if (!userId)
      throw new BadRequestException('An authenticated account is required')
    // Account ownership is mandatory, including for administrator accounts.
    // A disabled SMS gateway can still receive an app notification.
    const devices = await this.devices
      .find({ user: userId, fcmToken: { $type: 'string', $ne: '' } })
      .select('_id fcmToken')
      .limit(501)
      .lean()
      .exec()
    if (!devices.length)
      throw new BadRequestException(
        'No registered push-capable devices in this account',
      )
    if (devices.length > 500)
      throw new BadRequestException('Push broadcasts support up to 500 devices')
    const issuedAt = Date.now()
    try {
      const result = await firebase.messaging().sendEach(
        devices.map((device) => ({
          token: device.fcmToken,
          data: {
            type: 'platform_alert',
            alertId: createHash('sha256')
              .update(`${input.id}:${device._id}`)
              .digest('hex'),
            category: input.category,
            title: input.title,
            body: input.body,
            severity: input.severity,
            issuedAt: String(issuedAt),
            expiresAt: String(issuedAt + 300000),
            ...(input.url ? { url: input.url } : {}),
          },
          android: { priority: 'high' as const, ttl: 300000 },
        })),
      )
      // An obsolete registration must not prevent alerts reaching healthy phones.
      // Transient partial failure is retried; recipients deduplicate alertId.
      const terminal = new Set([
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
      ])
      const retryable =
        result.failureCount &&
        (!result.responses ||
          result.responses.some(
            (item) => !item.success && !terminal.has(item.error?.code),
          ))
      if (retryable || !result.successCount)
        throw new ServiceUnavailableException(
          'Some push devices did not accept the notification',
        )
      return {
        accepted: true,
        recipients: result.successCount,
        unreachable: result.failureCount,
        delivered: false,
      }
    } catch {
      // Do not expose registration tokens, Firebase internals or message contents.
      throw new ServiceUnavailableException(
        'Push broadcast could not be accepted; it can be retried',
      )
    }
  }
}
