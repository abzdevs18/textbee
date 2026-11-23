import { forwardRef, Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Device, DeviceSchema } from './schemas/device.schema'
import { DeviceTombstone, DeviceTombstoneSchema } from './schemas/device-tombstone.schema'
import { GatewayController } from './gateway.controller'
import { GatewayService } from './gateway.service'
import { AuthModule } from '../auth/auth.module'
import { UsersModule } from '../users/users.module'
import { SMS, SMSSchema } from './schemas/sms.schema'
import { SMSBatch, SMSBatchSchema } from './schemas/sms-batch.schema'
import { WebhookModule } from 'src/webhook/webhook.module'
import { BillingModule } from 'src/billing/billing.module'
import { BullModule } from '@nestjs/bull'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { SmsQueueService } from './queue/sms-queue.service'
import { SmsQueueProcessor } from './queue/sms-queue.processor'
import { SmsStatusUpdateTask } from './tasks/sms-status-update.task'
import { HeartbeatCheckTask } from './tasks/heartbeat-check.task'
import { SmsOutboxService } from './sms-outbox.service'
import { PushNotificationService } from './push-notification.service'
import { RemoteScreenController } from './remote-screen/remote-screen.controller'
import { RemoteScreenService } from './remote-screen/remote-screen.service'
import {
  RemoteCameraController,
  RemoteCameraStreamController,
} from './remote-screen/remote-camera.controller'
import {
  REMOTE_CAMERA_STORE,
  RemoteCameraService,
} from './remote-screen/remote-camera.service'
import {
  createRemoteScreenStore,
  RemoteScreenStore,
} from './remote-screen/remote-screen.store'

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Device.name,
        schema: DeviceSchema,
      },
      {
        name: DeviceTombstone.name,
        schema: DeviceTombstoneSchema,
      },
      {
        name: SMS.name,
        schema: SMSSchema,
      },
      {
        name: SMSBatch.name,
        schema: SMSBatchSchema,
      },
    ]),
    BullModule.registerQueueAsync({
      name: 'sms',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        limiter: {
          max: configService.get<number>('SMS_QUEUE_LIMITER_MAX', 20),
          duration: configService.get<number>('SMS_QUEUE_LIMITER_DURATION_MS', 1000),
        },
        defaultJobOptions: {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: { age: 24 * 3600 }, // 24 hours
          removeOnFail: { age: 72 * 3600 }, // 72 hours
        },
      }),
    }),
    AuthModule,
    UsersModule,
    WebhookModule,
    forwardRef(() => BillingModule),
    ConfigModule,
  ],
  controllers: [
    GatewayController,
    RemoteScreenController,
    RemoteCameraController,
    RemoteCameraStreamController,
  ],
  providers: [
    GatewayService,
    PushNotificationService,
    RemoteScreenService,
    {
      provide: RemoteScreenStore,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createRemoteScreenStore(configService.get<string>('REDIS_URL')),
    },
    RemoteCameraService,
    {
      provide: REMOTE_CAMERA_STORE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createRemoteScreenStore(
          configService.get<string>('REDIS_URL'),
          'remote-camera',
        ),
    },
    SmsOutboxService,
    SmsQueueService,
    SmsQueueProcessor,
    SmsStatusUpdateTask,
    HeartbeatCheckTask,
  ],
  exports: [MongooseModule, GatewayService, SmsQueueService, SmsOutboxService],
})
export class GatewayModule {}
