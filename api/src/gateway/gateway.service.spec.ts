import { Test, TestingModule } from '@nestjs/testing'
import { GatewayService } from './gateway.service'
import { AuthModule } from '../auth/auth.module'
import { getModelToken } from '@nestjs/mongoose'
import { Device, DeviceDocument } from './schemas/device.schema'
import { DeviceTombstone } from './schemas/device-tombstone.schema'
import { SMS } from './schemas/sms.schema'
import { SMSBatch } from './schemas/sms-batch.schema'
import { AuthService } from '../auth/auth.service'
import { WebhookService } from '../webhook/webhook.service'
import { BillingService } from '../billing/billing.service'
import { SmsQueueService } from './queue/sms-queue.service'
import { SmsOutboxService } from './sms-outbox.service'
import { Model, Types } from 'mongoose'
import { ConfigModule } from '@nestjs/config'
import { HttpException, HttpStatus } from '@nestjs/common'
import * as firebaseAdmin from 'firebase-admin'
import { SMSType } from './sms-type.enum'
import { WebhookEvent } from '../webhook/webhook-event.enum'
import { RegisterDeviceInputDTO, SendBulkSMSInputDTO, SendSMSInputDTO } from './gateway.dto'
import { User } from '../users/schemas/user.schema'
import { BatchResponse } from 'firebase-admin/messaging'
import { DEVICE_IN_FLIGHT_STATUSES } from './sms-delivery.constants'

// Mock firebase-admin
jest.mock('firebase-admin', () => ({
  messaging: jest.fn().mockReturnValue({
    sendEach: jest.fn(),
  }),
}))

describe('GatewayService', () => {
  let service: GatewayService
  let deviceModel: Model<DeviceDocument>
  let deviceTombstoneModel: Model<any>
  let smsModel: Model<SMS>
  let smsBatchModel: Model<SMSBatch>
  let authService: AuthService
  let webhookService: WebhookService
  let billingService: BillingService
  let smsQueueService: SmsQueueService

  const mockDeviceModel = {
    findOne: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    create: jest.fn(),
    exec: jest.fn(),
    countDocuments: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  }

  const mockSmsModel = {
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    distinct: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn(),
  }

  const mockSmsBatchModel = {
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    deleteMany: jest.fn(),
  }

  const mockDeviceTombstoneModel = {
    updateOne: jest.fn(),
  }

  const mockAuthService = {
    getUserApiKeys: jest.fn(),
  }

  const mockWebhookService = {
    deliverNotification: jest.fn(),
  }

  const mockBillingService = {
    canPerformAction: jest.fn(),
    getUserLimits: jest.fn(),
    notifyDeviceLimitReached: jest.fn(),
  }

  const mockSmsQueueService = {
    isQueueEnabled: jest.fn(),
    addSendSmsJob: jest.fn(),
  }

  const mockSmsOutboxService = {
    computeExpiresAt: jest.fn((requestedAt: Date) => new Date(requestedAt.getTime() + 2 * 60 * 60 * 1000)),
    dispatchMany: jest.fn().mockResolvedValue([]),
    tryDispatchSms: jest.fn(),
    handleSendFailureAndFailover: jest.fn(),
    claimForDevice: jest.fn().mockResolvedValue({ claimed: 0, messages: [] }),
    notifyWorkAvailable: jest.fn().mockResolvedValue(undefined),
    dispatchWaitingOutbox: jest.fn().mockResolvedValue(0),
    countWaitingOutbox: jest.fn().mockResolvedValue(0),
    getDeviceHealthSummary: jest.fn().mockResolvedValue({
      inFlight: 0,
      recentFailures: 0,
      maxInFlight: 5,
      failureThreshold: 3,
      failureCooldownMinutes: 5,
      isPaused: false,
    }),
    cancelAllExpired: jest.fn(),
    reclaimExpiredLeases: jest.fn(),
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewayService,
        {
          provide: getModelToken(Device.name),
          useValue: mockDeviceModel,
        },
        {
          provide: getModelToken(DeviceTombstone.name),
          useValue: mockDeviceTombstoneModel,
        },
        {
          provide: getModelToken(SMS.name),
          useValue: mockSmsModel,
        },
        {
          provide: getModelToken(SMSBatch.name),
          useValue: mockSmsBatchModel,
        },
        {
          provide: AuthService,
          useValue: mockAuthService,
        },
        {
          provide: WebhookService,
          useValue: mockWebhookService,
        },
        {
          provide: BillingService,
          useValue: mockBillingService,
        },
        {
          provide: SmsQueueService,
          useValue: mockSmsQueueService,
        },
        {
          provide: SmsOutboxService,
          useValue: mockSmsOutboxService,
        },
      ],
      imports: [ConfigModule],
    }).compile()

    service = module.get<GatewayService>(GatewayService)
    deviceModel = module.get<Model<DeviceDocument>>(getModelToken(Device.name))
    deviceTombstoneModel = module.get<Model<any>>(
      getModelToken(DeviceTombstone.name),
    )
    smsModel = module.get<Model<SMS>>(getModelToken(SMS.name))
    smsBatchModel = module.get<Model<SMSBatch>>(getModelToken(SMSBatch.name))
    authService = module.get<AuthService>(AuthService)
    webhookService = module.get<WebhookService>(WebhookService)
    billingService = module.get<BillingService>(BillingService)
    smsQueueService = module.get<SmsQueueService>(SmsQueueService)

    // Reset all mocks
    jest.clearAllMocks()
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  describe('registerDevice', () => {
    const mockUser = { 
      _id: 'user123', 
      name: 'Test User', 
      email: 'test@example.com',
      password: 'password',
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date()
    } as unknown as User;
    
    const mockDeviceInput: RegisterDeviceInputDTO = {
      model: 'Pixel 6',
      buildId: 'build123',
      fcmToken: 'token123',
      enabled: true,
    }
    const mockDevice = {
      _id: 'device123',
      ...mockDeviceInput,
      user: mockUser._id,
      // TODO: add more tests for different app version codes
      appVersionCode: 11,
    }

    it('should update the device that already owns this FCM token', async () => {
      mockDeviceModel.findOne.mockResolvedValue(mockDevice)
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({
        ...mockDevice,
        fcmToken: 'updatedToken',
      })

      // The implementation internally uses the _id from the found device to update it
      // So we need to avoid the internal call to updateDevice which is failing in the test
      // by mocking the service method directly and restoring it after the test
      const originalUpdateDevice = service.updateDevice;
      service.updateDevice = jest.fn().mockResolvedValue({
        ...mockDevice,
        fcmToken: 'updatedToken',
      });

      const result = await service.registerDevice(mockDeviceInput, mockUser)

      expect(mockDeviceModel.findOne).toHaveBeenCalledWith({
        user: mockUser._id,
        fcmToken: mockDeviceInput.fcmToken,
      })
      expect(service.updateDevice).toHaveBeenCalledWith(
        mockDevice._id.toString(),
        expect.objectContaining({
          ...mockDeviceInput,
          enabled: true,
          user: mockUser,
          fcmTokenUpdatedAt: expect.any(Date),
        }),
      )
      // Invalidation is lifted by updateDevice with $unset, never via the payload
      const forwarded = (service.updateDevice as jest.Mock).mock.calls[0][1]
      expect(forwarded).not.toHaveProperty('fcmTokenInvalidatedAt')
      expect(forwarded).not.toHaveProperty('fcmTokenInvalidReason')
      expect(result).toBeDefined()
      
      // Restore the original method
      service.updateDevice = originalUpdateDevice;
    })

    it('should create a new device if it does not exist', async () => {
      mockDeviceModel.findOne.mockResolvedValue(null)
      mockDeviceModel.create.mockResolvedValue(mockDevice)

      const result = await service.registerDevice(mockDeviceInput, mockUser)

      expect(mockDeviceModel.findOne).toHaveBeenCalledWith({
        user: mockUser._id,
        fcmToken: mockDeviceInput.fcmToken,
      })
      expect(mockDeviceModel.create).toHaveBeenCalledWith({
        ...mockDeviceInput,
        user: mockUser,
        fcmTokenUpdatedAt: expect.any(Date),
      })
      expect(result).toBeDefined()
    })

    it('should default a new device to enabled when the client omits enabled', async () => {
      // 2.8+ clients register without an `enabled` field; the server must
      // still create the device enabled so it works without a manual toggle.
      const inputWithoutEnabled: RegisterDeviceInputDTO = {
        model: 'Pixel 6',
        buildId: 'build123',
        fcmToken: 'token123',
      }
      mockDeviceModel.findOne.mockResolvedValue(null)
      mockBillingService.getUserLimits.mockResolvedValue({ deviceLimit: -1 })
      mockDeviceModel.create.mockResolvedValue({ _id: 'device123' })

      await service.registerDevice(inputWithoutEnabled, mockUser)

      expect(mockDeviceModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      )
    })

    it('should create a separate row for a second identical phone', async () => {
      // Two handsets of the same model on the same ROM share model+buildId.
      // Matching on those would hand phone B the row belonging to phone A, and
      // phone A then vanishes from the account.
      const otherPhone = {
        _id: 'devicePhoneA',
        model: 'Pixel 6',
        buildId: 'build123',
        fcmToken: 'tokenPhoneA',
        appVersionCode: 37,
      }
      mockDeviceModel.findOne
        .mockResolvedValueOnce(null) // no row owns this token
        .mockResolvedValueOnce(otherPhone) // same model/buildId, different phone
      mockBillingService.getUserLimits.mockResolvedValue({ deviceLimit: -1 })
      mockDeviceModel.create.mockResolvedValue({ _id: 'devicePhoneB' })
      const originalUpdateDevice = service.updateDevice
      service.updateDevice = jest.fn()

      await service.registerDevice(
        { ...mockDeviceInput, fcmToken: 'tokenPhoneB' },
        mockUser,
      )

      expect(service.updateDevice).not.toHaveBeenCalled()
      expect(mockDeviceModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ fcmToken: 'tokenPhoneB' }),
      )

      service.updateDevice = originalUpdateDevice
    })

    it('should still re-enable a legacy client row matched by model and buildId', async () => {
      mockDeviceModel.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...mockDevice, appVersionCode: 11 })
      const originalUpdateDevice = service.updateDevice
      service.updateDevice = jest.fn().mockResolvedValue({ _id: 'device123' })

      await service.registerDevice(mockDeviceInput, mockUser)

      expect(service.updateDevice).toHaveBeenCalledWith(
        'device123',
        expect.objectContaining({ enabled: true }),
      )
      expect(mockDeviceModel.create).not.toHaveBeenCalled()

      service.updateDevice = originalUpdateDevice
    })

    it('should clear the FCM token from stale duplicate rows after creating a device', async () => {
      mockDeviceModel.findOne.mockResolvedValue(null)
      mockBillingService.getUserLimits.mockResolvedValue({ deviceLimit: -1 })
      mockDeviceModel.create.mockResolvedValue({ _id: 'deviceNew' })

      await service.registerDevice(mockDeviceInput, mockUser)

      expect(mockDeviceModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          user: mockUser._id,
          fcmToken: mockDeviceInput.fcmToken,
          _id: { $ne: 'deviceNew' },
        }),
        expect.objectContaining({ $unset: { fcmToken: '' } }),
      )
    })

    it('should block registration when the device limit is already reached', async () => {
      mockDeviceModel.findOne.mockResolvedValue(null)
      mockBillingService.getUserLimits.mockResolvedValue({ deviceLimit: 1 })
      mockBillingService.notifyDeviceLimitReached.mockResolvedValue(undefined)
      mockDeviceModel.countDocuments.mockResolvedValue(1)

      await expect(
        service.registerDevice(mockDeviceInput, mockUser),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS })
      expect(mockDeviceModel.create).not.toHaveBeenCalled()
    })
  })

  describe('getDevicesForUser', () => {
    const mockUser = { 
      _id: 'user123', 
      name: 'Test User', 
      email: 'test@example.com',
      password: 'password',
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date()
    } as unknown as User;
    
    const mockDevices = [
      { _id: 'device1', model: 'Pixel 6' },
      { _id: 'device2', model: 'iPhone 13' },
    ]

    it('should return all devices for a user', async () => {
      mockDeviceModel.find.mockResolvedValue(mockDevices)

      const result = await service.getDevicesForUser(mockUser)

      expect(mockDeviceModel.find).toHaveBeenCalledWith({ user: mockUser._id })
      expect(result).toEqual(mockDevices)
    })
  })

  describe('getDeviceById', () => {
    const mockDevice = { _id: 'device123', model: 'Pixel 6' }

    it('should return device by id', async () => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)

      const result = await service.getDeviceById('device123')

      expect(mockDeviceModel.findById).toHaveBeenCalledWith('device123')
      expect(result).toEqual(mockDevice)
    })
  })

  describe('updateDevice', () => {
    const mockDeviceId = 'device123'
    const mockDeviceInput: RegisterDeviceInputDTO = {
      model: 'Pixel 6',
      buildId: 'build123',
      fcmToken: 'updatedToken',
      enabled: true,
    }
    const mockDevice = {
      _id: mockDeviceId,
      ...mockDeviceInput,
    }

    it('should update device if it exists', async () => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({
        ...mockDevice,
        fcmToken: 'updatedToken',
      })

      const result = await service.updateDevice(mockDeviceId, mockDeviceInput)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockDeviceModel.findByIdAndUpdate).toHaveBeenCalledWith(
        mockDeviceId,
        { $set: mockDeviceInput },
        { new: true },
      )
      expect(result).toBeDefined()
    })

    it('should throw an error if device does not exist', async () => {
      mockDeviceModel.findById.mockResolvedValue(null)

      await expect(
        service.updateDevice(mockDeviceId, mockDeviceInput),
      ).rejects.toThrow(HttpException)
      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockDeviceModel.findByIdAndUpdate).not.toHaveBeenCalled()
    })

    it('should lift an FCM invalidation with $unset when the token rotates', async () => {
      // Mongoose 9 strips `$set: { field: undefined }`, so only an explicit
      // $unset can clear the flag that excludes a phone from dispatch/claims.
      mockDeviceModel.findById.mockResolvedValue({
        ...mockDevice,
        fcmToken: 'oldToken',
        fcmTokenInvalidatedAt: new Date(),
        fcmTokenInvalidReason: 'FCM_TOKEN_NOT_REGISTERED',
      })
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({ ...mockDevice })

      await service.updateDevice(mockDeviceId, { fcmToken: 'freshToken' })

      const [, update] = mockDeviceModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$set).toEqual(
        expect.objectContaining({
          fcmToken: 'freshToken',
          fcmTokenUpdatedAt: expect.any(Date),
        }),
      )
      expect(update.$set).not.toHaveProperty('fcmTokenInvalidatedAt')
      expect(update.$unset).toEqual({
        fcmTokenInvalidatedAt: '',
        fcmTokenInvalidReason: '',
      })
    })

    it('should lift an FCM invalidation when the handset re-asserts the same token', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        ...mockDevice,
        fcmTokenInvalidatedAt: new Date(),
      })
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({ ...mockDevice })

      await service.updateDevice(mockDeviceId, {
        fcmToken: mockDeviceInput.fcmToken,
      })

      const [, update] = mockDeviceModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$unset).toEqual({
        fcmTokenInvalidatedAt: '',
        fcmTokenInvalidReason: '',
      })
    })

    it('should not let a client payload write invalidation bookkeeping', async () => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({ ...mockDevice })

      await service.updateDevice(mockDeviceId, {
        name: 'Front desk',
        fcmTokenInvalidatedAt: new Date(),
      } as any)

      const [, update] = mockDeviceModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$set).not.toHaveProperty('fcmTokenInvalidatedAt')
      expect(update.$unset).toBeUndefined()
    })
  })

  describe('assignDeviceTenant', () => {
    const mockDeviceId = 'device123'
    const mockDevice = { _id: mockDeviceId, model: 'Pixel 6' }

    it('assigns a tenant tag without touching other device fields', async () => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({
        ...mockDevice,
        assignedTenantTag: 'aans',
      })

      const result = await service.assignDeviceTenant(mockDeviceId, '  aans  ')

      expect(mockDeviceModel.findByIdAndUpdate).toHaveBeenCalledWith(
        mockDeviceId,
        { $set: { assignedTenantTag: 'aans' } },
        { new: true },
      )
      expect(result.assignedTenantTag).toBe('aans')
    })

    it('unassigns a device back to the shared pool', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        ...mockDevice,
        assignedTenantTag: 'aans',
      })
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue(mockDevice)

      await service.assignDeviceTenant(mockDeviceId, null)

      expect(mockDeviceModel.findByIdAndUpdate).toHaveBeenCalledWith(
        mockDeviceId,
        { $unset: { assignedTenantTag: 1 } },
        { new: true },
      )
    })

    it('rejects an invalid tenant tag', async () => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)

      await expect(
        service.assignDeviceTenant(mockDeviceId, 'bad tag!'),
      ).rejects.toThrow(HttpException)
      expect(mockDeviceModel.findByIdAndUpdate).not.toHaveBeenCalled()
    })
  })

  describe('deleteDevice', () => {
    const mockDeviceId = '507f1f77bcf86cd799439011'
    const mockDevice = { _id: mockDeviceId, model: 'Pixel 6' }

    it('should tombstone and delete when device exists', async () => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)

      const result = await service.deleteDevice(mockDeviceId)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockDeviceTombstoneModel.updateOne).toHaveBeenCalled()
      expect(mockDeviceModel.findByIdAndDelete).toHaveBeenCalledWith(mockDeviceId)
      expect(result).toEqual({ success: true })
    })

    it('should throw an error if device does not exist', async () => {
      mockDeviceModel.findById.mockResolvedValue(null)

      await expect(service.deleteDevice(mockDeviceId)).rejects.toThrow(
        HttpException,
      )
      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
    })
  })

  describe('sendSMS', () => {
    const mockDeviceId = 'device123'
    const mockDevice = {
      _id: mockDeviceId,
      enabled: true,
      fcmToken: 'fcm-token',
      user: 'user123',
    }
    const mockSmsInput: SendSMSInputDTO = {
      message: 'Hello there',
      recipients: ['+123456789'],
      smsBody: 'Hello there',
      receivers: ['+123456789'],
    }
    const mockSms = {
      _id: 'sms123',
      device: mockDeviceId,
      message: mockSmsInput.message,
      type: SMSType.SENT,
      recipient: mockSmsInput.recipients[0],
      status: 'pending',
    }
    const mockSmsBatch = {
      _id: 'batch123',
      device: mockDeviceId,
      message: mockSmsInput.message,
      recipientCount: 1,
      status: 'pending',
    }
    const mockFcmResponse: BatchResponse = {
      successCount: 1,
      failureCount: 0,
      responses: [],
    }

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockSmsBatchModel.create.mockResolvedValue(mockSmsBatch)
      mockSmsModel.create.mockResolvedValue(mockSms)
      mockDeviceModel.findByIdAndUpdate.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue(true),
      }))
      mockSmsBatchModel.findByIdAndUpdate.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue(true),
      }))
      mockBillingService.canPerformAction.mockResolvedValue(true)
      mockSmsQueueService.isQueueEnabled.mockReturnValue(false)
      
      // Fix the mock
      jest.spyOn(firebaseAdmin.messaging(), 'sendEach').mockResolvedValue(mockFcmResponse)
    })

    it('should send SMS successfully via central outbox', async () => {
      mockSmsOutboxService.dispatchMany.mockResolvedValue([
        { smsId: 'sms123', status: 'dispatched', deviceId: mockDeviceId },
      ])

      const result = await service.sendSMS(mockDeviceId, mockSmsInput)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockBillingService.canPerformAction).toHaveBeenCalledWith(
        mockDevice.user.toString(),
        'send_sms',
        mockSmsInput.recipients.length,
      )
      expect(mockSmsBatchModel.create).toHaveBeenCalled()
      expect(mockSmsModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          preferredDevice: mockDevice._id,
          expiresAt: expect.any(Date),
          maxAttempts: expect.any(Number),
        }),
      )
      expect(mockSmsOutboxService.dispatchMany).toHaveBeenCalled()
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          smsBatchId: mockSmsBatch._id,
          outbox: expect.objectContaining({
            dispatched: 1,
          }),
        }),
      )
    })

    it('persists a normalized immutable tenant tag on every outbound SMS', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        ...mockDevice,
        assignedTenantTag: 'ws_school_404617',
      })
      mockSmsOutboxService.dispatchMany.mockResolvedValue([
        { smsId: 'sms123', status: 'dispatched', deviceId: mockDeviceId },
      ])

      await service.sendSMS(mockDeviceId, {
        ...mockSmsInput,
        tenantTag: 'WS_SCHOOL_404617',
      })

      expect(mockSmsModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantTag: 'ws_school_404617',
          preferredDevice: mockDevice._id,
        }),
      )
    })

    it('rejects a stale preferred device that was reassigned to another school', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        ...mockDevice,
        assignedTenantTag: 'evaa',
      })

      await expect(service.sendSMS(mockDeviceId, {
        ...mockSmsInput,
        tenantTag: 'ws_school_404617',
      })).rejects.toThrow(HttpException)

      expect(mockBillingService.canPerformAction).not.toHaveBeenCalled()
      expect(mockSmsModel.create).not.toHaveBeenCalled()
    })

    it('should throw error if device is not enabled', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        ...mockDevice,
        enabled: false,
      })

      await expect(
        service.sendSMS(mockDeviceId, mockSmsInput),
      ).rejects.toThrow(HttpException)
      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockBillingService.canPerformAction).not.toHaveBeenCalled()
    })

    it('should throw error if message is blank', async () => {
      await expect(
        service.sendSMS(mockDeviceId, { ...mockSmsInput, message: '', smsBody: '' }),
      ).rejects.toThrow(HttpException)
    })

    it('should throw error if recipients are invalid', async () => {
      await expect(
        service.sendSMS(mockDeviceId, { ...mockSmsInput, recipients: [] }),
      ).rejects.toThrow(HttpException)
    })

    it('should still accept SMS when preferred device is busy (outbox assigns free device)', async () => {
      mockSmsOutboxService.getDeviceHealthSummary.mockResolvedValue({
        inFlight: 5,
        recentFailures: 0,
        maxInFlight: 5,
        failureThreshold: 3,
        failureCooldownMinutes: 5,
        isPaused: true,
      })
      mockSmsOutboxService.dispatchMany.mockResolvedValue([
        { smsId: 'sms123', status: 'pending', reason: 'NO_ELIGIBLE_DEVICE' },
      ])

      const result = await service.sendSMS(mockDeviceId, mockSmsInput)

      expect(mockBillingService.canPerformAction).toHaveBeenCalled()
      expect(mockSmsBatchModel.create).toHaveBeenCalled()
      expect(result.success).toBe(true)
      expect(result.outbox.pending).toBe(1)
    })

    it('should dispatch via outbox (queue path superseded by central outbox)', async () => {
      mockSmsOutboxService.dispatchMany.mockResolvedValue([
        { smsId: 'sms123', status: 'dispatched', deviceId: mockDeviceId },
      ])

      const result = await service.sendSMS(mockDeviceId, mockSmsInput)

      expect(mockSmsOutboxService.dispatchMany).toHaveBeenCalled()
      expect(result).toHaveProperty('success', true)
      expect(result).toHaveProperty('smsBatchId', mockSmsBatch._id)
      expect(result.outbox.dispatched).toBe(1)
    })
  })

  describe('sendBulkSMS', () => {
    const mockDeviceId = 'device123'
    const mockDevice = {
      _id: mockDeviceId,
      enabled: true,
      fcmToken: 'fcm-token',
      user: 'user123',
    }
    const mockBulkSmsInput: SendBulkSMSInputDTO = {
      messageTemplate: 'Hello {name}',
      messages: [
        {
          message: 'Hello John',
          recipients: ['+123456789'],
          smsBody: 'Hello John',
          receivers: ['+123456789'],
        },
        {
          message: 'Hello Jane',
          recipients: ['+987654321'],
          smsBody: 'Hello Jane',
          receivers: ['+987654321'],
        },
      ],
    }
    const mockSmsBatch = {
      _id: 'batch123',
      device: mockDeviceId,
      message: mockBulkSmsInput.messageTemplate,
      recipientCount: 2,
      status: 'pending',
    }
    const mockSms = {
      _id: 'sms123',
      device: mockDeviceId,
      message: 'Hello John',
      type: SMSType.SENT,
      recipient: '+123456789',
      status: 'pending',
    }
    const mockFcmResponse: BatchResponse = {
      successCount: 1,
      failureCount: 0,
      responses: [],
    }

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockSmsBatchModel.create.mockResolvedValue(mockSmsBatch)
      mockSmsModel.create.mockResolvedValue(mockSms)
      mockDeviceModel.findByIdAndUpdate.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue(true),
      }))
      mockSmsBatchModel.findByIdAndUpdate.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue(true),
      }))
      mockBillingService.canPerformAction.mockResolvedValue(true)
      mockSmsQueueService.isQueueEnabled.mockReturnValue(false)
      
      // Fix the mock
      jest.spyOn(firebaseAdmin.messaging(), 'sendEach').mockResolvedValue(mockFcmResponse)
    })

    it('should send bulk SMS successfully via outbox', async () => {
      ;(mockSmsModel as any).insertMany = jest.fn().mockResolvedValue([
        { _id: 'sms1' },
        { _id: 'sms2' },
      ])
      mockSmsOutboxService.dispatchMany.mockResolvedValue([
        { smsId: 'sms1', status: 'dispatched', deviceId: mockDeviceId },
        { smsId: 'sms2', status: 'dispatched', deviceId: mockDeviceId },
      ])

      const result = await service.sendBulkSMS(mockDeviceId, mockBulkSmsInput)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockBillingService.canPerformAction).toHaveBeenCalledWith(
        mockDevice.user.toString(),
        'bulk_send_sms',
        2,
      )
      expect(mockSmsBatchModel.create).toHaveBeenCalled()
      expect(mockSmsOutboxService.dispatchMany).toHaveBeenCalled()
      expect(result).toHaveProperty('success', true)
      expect(result.successCount).toBe(2)
    })

    it('should accept bulk SMS into outbox even when pending free device', async () => {
      ;(mockSmsModel as any).insertMany = jest.fn().mockResolvedValue([
        { _id: 'sms1' },
        { _id: 'sms2' },
      ])
      mockSmsOutboxService.dispatchMany.mockResolvedValue([
        { smsId: 'sms1', status: 'pending' },
        { smsId: 'sms2', status: 'pending' },
      ])

      const result = await service.sendBulkSMS(mockDeviceId, mockBulkSmsInput)

      expect(result).toHaveProperty('success', true)
      expect(result).toHaveProperty('smsBatchId', mockSmsBatch._id)
      expect(result.pendingCount).toBe(2)
    })
  })

  describe('receiveSMS', () => {
    const mockDeviceId = 'device123'
    const mockDevice = {
      _id: mockDeviceId,
      user: 'user123',
    }
    const mockReceivedSmsData = {
      message: 'Hello from test',
      sender: '+123456789',
      receivedAt: new Date(),
    }
    const mockSms = {
      _id: 'sms123',
      ...mockReceivedSmsData,
      device: mockDeviceId,
      type: SMSType.RECEIVED,
    }

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockSmsModel.findOne.mockResolvedValue(null)
      mockSmsModel.create.mockResolvedValue(mockSms)
      mockDeviceModel.findByIdAndUpdate.mockImplementation(() => ({
        exec: jest.fn().mockResolvedValue(true),
      }))
      mockBillingService.canPerformAction.mockResolvedValue(true)
      mockWebhookService.deliverNotification.mockResolvedValue(true)
    })

    it('should receive SMS successfully', async () => {
      const result = await service.receiveSMS(mockDeviceId, mockReceivedSmsData)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockBillingService.canPerformAction).toHaveBeenCalledWith(
        mockDevice.user.toString(),
        'receive_sms',
        1,
      )
      expect(mockSmsModel.create).toHaveBeenCalled()
      expect(mockDeviceModel.findByIdAndUpdate).toHaveBeenCalled()
      expect(mockWebhookService.deliverNotification).toHaveBeenCalledWith({
        sms: mockSms,
        user: mockDevice.user,
        event: WebhookEvent.MESSAGE_RECEIVED,
      })
      expect(result).toEqual(mockSms)
    })

    it('should throw error if device does not exist', async () => {
      mockDeviceModel.findById.mockResolvedValue(null)

      await expect(
        service.receiveSMS(mockDeviceId, mockReceivedSmsData),
      ).rejects.toThrow(HttpException)
    })

    it('should throw error if SMS data is invalid', async () => {
      await expect(
        service.receiveSMS(mockDeviceId, { ...mockReceivedSmsData, message: '' }),
      ).rejects.toThrow(HttpException)
    })
  })

  describe('getReceivedSMS', () => {
    const mockDeviceId = 'device123'
    const mockDevice = {
      _id: mockDeviceId,
    }
    const mockSmsData = [
      {
        _id: 'sms1',
        message: 'Hello 1',
        type: SMSType.RECEIVED,
        sender: '+123456789',
        receivedAt: new Date(),
      },
      {
        _id: 'sms2',
        message: 'Hello 2',
        type: SMSType.RECEIVED,
        sender: '+987654321',
        receivedAt: new Date(),
      },
    ]

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockSmsModel.find.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mockSmsData),
        }),
      })
      mockSmsModel.countDocuments.mockResolvedValue(2)
    })

    it('should get received SMS with pagination', async () => {
      const result = await service.getReceivedSMS(mockDeviceId, 1, 10)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockSmsModel.countDocuments).toHaveBeenCalledWith({
        device: mockDevice._id,
        type: SMSType.RECEIVED,
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          type: SMSType.RECEIVED,
        },
        null,
        {
          sort: { receivedAt: -1 },
          limit: 10,
          skip: 0,
        },
      )
      expect(result).toHaveProperty('data', mockSmsData)
      expect(result).toHaveProperty('meta')
      expect(result.meta).toHaveProperty('total', 2)
    })

    it('should throw error if device does not exist', async () => {
      mockDeviceModel.findById.mockResolvedValue(null)

      await expect(service.getReceivedSMS(mockDeviceId)).rejects.toThrow(
        HttpException,
      )
    })
  })

  describe('getMessages', () => {
    const mockDeviceId = 'device123'
    const mockDevice = {
      _id: mockDeviceId,
    }
    const mockSmsData = [
      {
        _id: 'sms1',
        message: 'Hello 1',
        type: SMSType.SENT,
        recipient: '+123456789',
        createdAt: new Date(),
      },
      {
        _id: 'sms2',
        message: 'Hello 2',
        type: SMSType.RECEIVED,
        sender: '+987654321',
        createdAt: new Date(),
      },
    ]

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue(mockDevice)
      mockSmsModel.find.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mockSmsData),
        }),
      })
      mockSmsModel.countDocuments.mockResolvedValue(2)
    })

    it('should get all messages with pagination', async () => {
      const result = await service.getMessages(mockDeviceId, '', 1, 10)

      expect(mockDeviceModel.findById).toHaveBeenCalledWith(mockDeviceId)
      expect(mockSmsModel.countDocuments).toHaveBeenCalledWith({
        device: mockDevice._id,
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
        },
        null,
        {
          sort: { createdAt: -1 },
          limit: 10,
          skip: 0,
        },
      )
      expect(result).toHaveProperty('data', mockSmsData)
      expect(result).toHaveProperty('meta')
      expect(result.meta).toHaveProperty('total', 2)
    })

    it('should get sent messages with pagination', async () => {
      const result = await service.getMessages(mockDeviceId, 'sent', 1, 10)

      expect(mockSmsModel.countDocuments).toHaveBeenCalledWith({
        device: mockDevice._id,
        type: SMSType.SENT,
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          type: SMSType.SENT,
        },
        null,
        expect.any(Object),
      )
    })

    it('should get received messages with pagination', async () => {
      const result = await service.getMessages(mockDeviceId, 'received', 1, 10)

      expect(mockSmsModel.countDocuments).toHaveBeenCalledWith({
        device: mockDevice._id,
        type: SMSType.RECEIVED,
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          type: SMSType.RECEIVED,
        },
        null,
        expect.any(Object),
      )
    })

    it('should throw error if device does not exist', async () => {
      mockDeviceModel.findById.mockResolvedValue(null)

      await expect(service.getMessages(mockDeviceId)).rejects.toThrow(
        HttpException,
      )
    })
  })

  describe('getAccountMessages', () => {
    const mockUserId = new Types.ObjectId().toString()
    const mockDeviceId = new Types.ObjectId().toString()
    const mockUser = {
      _id: mockUserId,
      name: 'Test User',
      email: 'test@example.com',
      password: 'password',
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as User
    const mockSmsData = [
      {
        _id: new Types.ObjectId().toString(),
        device: mockDeviceId,
        message: 'Hello from device',
        type: SMSType.SENT,
        recipient: '+123456789',
        status: 'unknown',
        createdAt: new Date(),
      },
    ]

    beforeEach(() => {
      mockSmsModel.find.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mockSmsData),
        }),
      })
      mockSmsModel.countDocuments.mockResolvedValue(1)
    })

    it('should cast deviceId before filtering account messages', async () => {
      const result = await service.getAccountMessages(mockUser, {
        deviceId: mockDeviceId,
        status: 'all',
        type: 'all',
        page: 1,
        limit: 10,
      })

      const findQuery = (mockSmsModel.find as jest.Mock).mock.calls[0][0]
      const countQuery = (mockSmsModel.countDocuments as jest.Mock).mock.calls[0][0]

      expect(findQuery.user).toBe(mockUserId)
      expect(findQuery.device).toBeInstanceOf(Types.ObjectId)
      expect(findQuery.device.toString()).toBe(mockDeviceId)
      expect(countQuery.device).toBeInstanceOf(Types.ObjectId)
      expect(countQuery.device.toString()).toBe(mockDeviceId)
      expect(result.data).toEqual(mockSmsData)
    })

    it('should reject invalid account message device filters', async () => {
      await expect(
        service.getAccountMessages(mockUser, {
          deviceId: 'not-a-device-id',
        }),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST })

      expect(mockSmsModel.find).not.toHaveBeenCalled()
      expect(mockSmsModel.countDocuments).not.toHaveBeenCalled()
    })
  })

  describe('getStatsForUser', () => {
    const mockUser = { 
      _id: 'user123', 
      name: 'Test User', 
      email: 'test@example.com',
      password: 'password',
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date()
    } as unknown as User;
    
    const mockDevices = [
      {
        _id: 'device1',
        sentSMSCount: 10,
        receivedSMSCount: 5,
      },
      {
        _id: 'device2',
        sentSMSCount: 20,
        receivedSMSCount: 15,
      },
    ]
    const mockApiKeys = [
      { _id: 'key1', name: 'API Key 1' },
      { _id: 'key2', name: 'API Key 2' },
    ]

    beforeEach(() => {
      mockDeviceModel.find.mockResolvedValue(mockDevices)
      mockAuthService.getUserApiKeys.mockResolvedValue(mockApiKeys)
    })

    it('should return stats for user', async () => {
      const result = await service.getStatsForUser(mockUser)

      expect(mockDeviceModel.find).toHaveBeenCalledWith({ user: mockUser._id })
      expect(mockAuthService.getUserApiKeys).toHaveBeenCalledWith(mockUser)
      expect(result).toEqual({
        totalSentSMSCount: 30,
        totalReceivedSMSCount: 20,
        totalDeviceCount: 2,
        totalApiKeyCount: 2,
      })
    })
  })

  describe('heartbeat', () => {
    const mockDeviceId = 'device123'

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue({
        _id: mockDeviceId,
        user: 'user123',
        enabled: true,
        fcmToken: 'token123',
      })
      mockDeviceModel.findByIdAndUpdate.mockResolvedValue({
        _id: mockDeviceId,
        name: 'Pixel 6',
        enabled: true,
      })
    })

    it('should never claim outbox SMS on behalf of the device', async () => {
      // The heartbeat response cannot carry SMS payloads, so claiming here
      // would strand messages in `dispatched` with no handset holding them.
      mockSmsOutboxService.countWaitingOutbox.mockResolvedValue(2)

      const result = await service.heartbeat(mockDeviceId, {})

      expect(mockSmsOutboxService.claimForDevice).not.toHaveBeenCalled()
      expect(mockSmsOutboxService.dispatchWaitingOutbox).toHaveBeenCalledWith(20)
      expect(mockSmsOutboxService.notifyWorkAvailable).toHaveBeenCalledWith(
        'user123',
      )
      expect(result).toEqual(
        expect.objectContaining({ success: true, outboxPending: 2 }),
      )
    })

    it('should not wake devices when nothing is waiting', async () => {
      mockSmsOutboxService.countWaitingOutbox.mockResolvedValue(0)

      const result = await service.heartbeat(mockDeviceId, {})

      expect(mockSmsOutboxService.notifyWorkAvailable).not.toHaveBeenCalled()
      expect(result).toEqual(
        expect.objectContaining({ outboxPending: 0, enabled: true }),
      )
    })

    it('should lift an FCM invalidation when the handset re-asserts its token', async () => {
      // Previously `$set: { fcmTokenInvalidatedAt: undefined }` was stripped by
      // Mongoose, so a flagged phone stayed excluded no matter how often it
      // heartbeated, rebooted or was force-stopped.
      mockDeviceModel.findById.mockResolvedValue({
        _id: mockDeviceId,
        user: 'user123',
        enabled: true,
        fcmToken: 'token123',
        fcmTokenInvalidatedAt: new Date(),
        fcmTokenInvalidReason: 'FCM_TOKEN_NOT_REGISTERED',
      })

      await service.heartbeat(mockDeviceId, { fcmToken: 'token123' })

      const [, update] = mockDeviceModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$unset).toEqual({
        fcmTokenInvalidatedAt: '',
        fcmTokenInvalidReason: '',
      })
      expect(update.$set).not.toHaveProperty('fcmTokenInvalidatedAt')
    })

    it('should store a rotated token and lift its invalidation', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        _id: mockDeviceId,
        user: 'user123',
        enabled: true,
        fcmToken: 'token123',
        fcmTokenInvalidatedAt: new Date(),
      })

      const result = await service.heartbeat(mockDeviceId, {
        fcmToken: 'rotatedToken',
      })

      const [, update] = mockDeviceModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$set).toEqual(
        expect.objectContaining({ fcmToken: 'rotatedToken' }),
      )
      expect(update.$unset).toEqual({
        fcmTokenInvalidatedAt: '',
        fcmTokenInvalidReason: '',
      })
      expect(result.fcmTokenUpdated).toBe(true)
    })

    it('should leave a healthy token alone', async () => {
      await service.heartbeat(mockDeviceId, { fcmToken: 'token123' })

      const [, update] = mockDeviceModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$unset).toBeUndefined()
    })
  })

  describe('hard delete message history', () => {
    const userId = new Types.ObjectId().toString()
    const user = { _id: userId } as unknown as User

    it('permanently deletes one terminal SMS owned by the account', async () => {
      const smsId = new Types.ObjectId().toString()
      const smsBatchId = new Types.ObjectId().toString()
      mockSmsModel.findById.mockResolvedValue({
        _id: smsId,
        user: userId,
        status: 'delivered',
        smsBatch: smsBatchId,
      })
      mockSmsModel.deleteOne.mockResolvedValue({ deletedCount: 1 })
      mockSmsModel.distinct.mockResolvedValueOnce([])
      mockSmsBatchModel.deleteMany.mockResolvedValue({ deletedCount: 1 })

      await expect(service.deleteMessage(smsId, user)).resolves.toEqual({
        success: true,
        deleted: 1,
        smsId,
      })
      expect(mockSmsModel.deleteOne).toHaveBeenCalledWith({
        _id: smsId,
        user: userId,
        status: { $nin: DEVICE_IN_FLIGHT_STATUSES },
      })
      expect(mockSmsBatchModel.deleteMany).toHaveBeenCalledWith({
        _id: { $in: [smsBatchId] },
        user: userId,
      })
    })

    it.each(['pending', 'dispatched'])(
      'refuses to delete an active %s SMS',
      async (status) => {
        const smsId = new Types.ObjectId().toString()
        mockSmsModel.findById.mockResolvedValue({
          _id: smsId,
          user: userId,
          status,
        })

        await expect(service.deleteMessage(smsId, user)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
        })
        expect(mockSmsModel.deleteOne).not.toHaveBeenCalled()
      },
    )

    it('keeps a shared batch while another SMS still references it', async () => {
      const smsId = new Types.ObjectId().toString()
      const smsBatchId = new Types.ObjectId().toString()
      mockSmsModel.findById.mockResolvedValue({
        _id: smsId,
        user: userId,
        status: 'failed',
        smsBatch: smsBatchId,
      })
      mockSmsModel.deleteOne.mockResolvedValue({ deletedCount: 1 })
      mockSmsModel.distinct.mockResolvedValueOnce([smsBatchId])

      await service.deleteMessage(smsId, user)

      expect(mockSmsBatchModel.deleteMany).not.toHaveBeenCalled()
    })

    it('hard deletes selected terminal SMS and reports protected active rows', async () => {
      const terminalSmsId = new Types.ObjectId().toString()
      const activeSmsId = new Types.ObjectId().toString()
      const smsBatchId = new Types.ObjectId().toString()
      mockSmsModel.countDocuments.mockResolvedValue(1)
      mockSmsModel.deleteMany.mockResolvedValue({ deletedCount: 1 })
      mockSmsModel.distinct
        .mockResolvedValueOnce([smsBatchId])
        .mockResolvedValueOnce([])
      mockSmsBatchModel.deleteMany.mockResolvedValue({ deletedCount: 1 })

      await expect(
        service.deleteMessages(user, [terminalSmsId, activeSmsId]),
      ).resolves.toEqual({
        success: true,
        requested: 2,
        deleted: 1,
        skippedActive: 1,
        notFoundOrNotOwned: 0,
      })
      expect(mockSmsModel.deleteMany).toHaveBeenCalledWith({
        _id: { $in: [terminalSmsId, activeSmsId] },
        user: userId,
        status: { $nin: DEVICE_IN_FLIGHT_STATUSES },
      })
      expect(mockSmsBatchModel.deleteMany).toHaveBeenCalledWith({
        _id: { $in: [smsBatchId] },
        user: userId,
      })
    })

    it('hard deletes matching history including records hidden by the old implementation', async () => {
      mockSmsModel.countDocuments.mockResolvedValue(2)
      mockSmsModel.deleteMany.mockResolvedValue({ deletedCount: 7 })

      await expect(service.deleteMessageHistory(user)).resolves.toEqual({
        success: true,
        deleted: 7,
        skippedActive: 2,
      })
      expect(mockSmsModel.deleteMany).toHaveBeenCalledWith({
        user: userId,
        status: { $nin: DEVICE_IN_FLIGHT_STATUSES },
      })
      expect(mockSmsModel.deleteMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ hiddenAt: expect.anything() }),
      )
    })
  })

  describe('updateSMSStatus device ownership', () => {
    const deviceId = new Types.ObjectId().toString()
    const otherDeviceId = new Types.ObjectId().toString()

    beforeEach(() => {
      mockDeviceModel.findById.mockResolvedValue({
        _id: deviceId,
        user: 'user123',
        enabled: true,
      })
      mockSmsModel.findByIdAndUpdate = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'sent',
      })
      mockSmsModel.find.mockResolvedValue([])
    })

    it('should accept a sent report from a device that held an earlier attempt', async () => {
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'dispatched',
        device: otherDeviceId,
        metadata: { dispatchAttempts: [{ deviceId }] },
      })

      const result = await service.updateSMSStatus(deviceId, {
        smsId: 'sms123',
        status: 'SENT',
        sentAtInMillis: Date.now(),
      } as any)

      expect(result).toEqual(
        expect.objectContaining({ success: true, message: expect.any(String) }),
      )
      // the reporting handset becomes the device of record
      expect(mockSmsModel.findByIdAndUpdate).toHaveBeenCalledWith(
        'sms123',
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'sent' }),
        }),
        { new: true },
      )
    })

    it('should reject a report from a device that never held the SMS', async () => {
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'dispatched',
        device: otherDeviceId,
        metadata: {},
      })

      await expect(
        service.updateSMSStatus(deviceId, {
          smsId: 'sms123',
          status: 'SENT',
        } as any),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    })

    it('should record a stale failure without disturbing the current attempt', async () => {
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'dispatched',
        device: otherDeviceId,
        metadata: { dispatchAttempts: [{ deviceId }] },
      })

      const result = await service.updateSMSStatus(deviceId, {
        smsId: 'sms123',
        status: 'FAILED',
        errorCode: 'GENERIC_FAILURE',
      } as any)

      expect(
        mockSmsOutboxService.handleSendFailureAndFailover,
      ).not.toHaveBeenCalled()
      expect(result).toEqual(expect.objectContaining({ ignored: true }))
    })

    it('should not re-send when a late failure arrives after SENT', async () => {
      // Older clients report every multipart part separately; a failed part
      // after a sent part used to trigger failover and a duplicate SMS.
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'sent',
        device: deviceId,
        attemptCount: 1,
        metadata: {},
      })

      const result = await service.updateSMSStatus(deviceId, {
        smsId: 'sms123',
        status: 'FAILED',
        errorCode: '1',
      } as any)

      expect(
        mockSmsOutboxService.handleSendFailureAndFailover,
      ).not.toHaveBeenCalled()
      expect(result).toEqual(expect.objectContaining({ ignored: true }))
    })

    it('should fence a failure from a superseded attempt without excluding the owner', async () => {
      // Single-phone setups: attempt 1 failed late while attempt 2 is already
      // in flight on the same phone. Excluding the phone would leave nobody
      // able to send the SMS.
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'dispatched',
        device: deviceId,
        attemptCount: 2,
        metadata: { dispatchAttempts: [{ deviceId }, { deviceId }] },
      })

      const result = await service.updateSMSStatus(deviceId, {
        smsId: 'sms123',
        status: 'FAILED',
        errorCode: '4',
        attempt: 1,
      } as any)

      expect(
        mockSmsOutboxService.handleSendFailureAndFailover,
      ).not.toHaveBeenCalled()
      expect(result).toEqual(expect.objectContaining({ ignored: true }))
      const [, update] = (mockSmsModel.findByIdAndUpdate as jest.Mock).mock.calls[0]
      expect(update.$addToSet).toBeUndefined()
      expect(update.$set['metadata.staleDeviceFailure']).toEqual(
        expect.objectContaining({ deviceId, attempt: 1 }),
      )
    })

    it('should not re-run failover for an SMS already back in the outbox', async () => {
      // The first FAILED requeued it (pending, backoff). Further FAILED reports
      // for that attempt — one per multipart part from 2.8.19 phones — used to
      // re-exclude the only phone and strand the SMS until the 2h cancel.
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'pending',
        device: deviceId,
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() + 60_000),
        metadata: { dispatchAttempts: [{ deviceId }] },
      })

      const result = await service.updateSMSStatus(deviceId, {
        smsId: 'sms123',
        status: 'FAILED',
        errorCode: '1',
      } as any)

      expect(
        mockSmsOutboxService.handleSendFailureAndFailover,
      ).not.toHaveBeenCalled()
      expect(result).toEqual(expect.objectContaining({ ignored: true }))
    })

    it('should fail over a failure from the current attempt', async () => {
      mockSmsModel.findById = jest.fn().mockResolvedValue({
        _id: 'sms123',
        status: 'dispatched',
        device: deviceId,
        attemptCount: 2,
        metadata: { dispatchAttempts: [{ deviceId }, { deviceId }] },
      })
      mockSmsOutboxService.handleSendFailureAndFailover.mockResolvedValue({
        smsId: 'sms123',
        status: 'pending',
        reason: 'RETRY_SCHEDULED',
      })

      const result = await service.updateSMSStatus(deviceId, {
        smsId: 'sms123',
        status: 'FAILED',
        errorCode: '4',
        attempt: 2,
      } as any)

      expect(
        mockSmsOutboxService.handleSendFailureAndFailover,
      ).toHaveBeenCalledWith('sms123', deviceId, '4', expect.any(String))
      expect(result).toEqual(
        expect.objectContaining({
          failover: expect.objectContaining({ status: 'pending' }),
        }),
      )
    })
  })

  describe('claimOutboxForDevice', () => {
    it('should pass resync through and clamp the claim limit', async () => {
      mockDeviceModel.findById.mockResolvedValue({
        _id: 'device123',
        enabled: true,
      })

      await service.claimOutboxForDevice('device123', 500, { resync: true })
      await service.claimOutboxForDevice('device123', 'nope' as any)

      expect(mockSmsOutboxService.claimForDevice).toHaveBeenNthCalledWith(
        1,
        'device123',
        20,
        { resync: true },
      )
      expect(mockSmsOutboxService.claimForDevice).toHaveBeenNthCalledWith(
        2,
        'device123',
        5,
        { resync: false },
      )
    })
  })
})
