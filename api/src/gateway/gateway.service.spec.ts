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
    countDocuments: jest.fn(),
  }

  const mockSmsBatchModel = {
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
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
          fcmTokenInvalidatedAt: undefined,
          fcmTokenInvalidReason: undefined,
        }),
      )
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
        fcmTokenInvalidatedAt: undefined,
        fcmTokenInvalidReason: undefined,
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
        hiddenAt: { $exists: false },
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          type: SMSType.RECEIVED,
          hiddenAt: { $exists: false },
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
        hiddenAt: { $exists: false },
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          hiddenAt: { $exists: false },
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
        hiddenAt: { $exists: false },
        type: SMSType.SENT,
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          hiddenAt: { $exists: false },
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
        hiddenAt: { $exists: false },
        type: SMSType.RECEIVED,
      })
      expect(mockSmsModel.find).toHaveBeenCalledWith(
        {
          device: mockDevice._id,
          hiddenAt: { $exists: false },
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
  })
})
