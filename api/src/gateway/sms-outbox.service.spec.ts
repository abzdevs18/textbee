import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { Types } from 'mongoose'
import * as firebaseAdmin from 'firebase-admin'
import { SmsOutboxService } from './sms-outbox.service'
import { Device } from './schemas/device.schema'
import { SMS } from './schemas/sms.schema'
import { SMSBatch } from './schemas/sms-batch.schema'
import { WebhookService } from '../webhook/webhook.service'
import { SMSType } from './sms-type.enum'
import { SMS_DISPATCH_LEASE_MS, SMS_LEASE_MS } from './sms-delivery.constants'

jest.mock('firebase-admin', () => ({
  messaging: jest.fn().mockReturnValue({
    sendEach: jest.fn(),
  }),
}))

describe('SmsOutboxService', () => {
  let service: SmsOutboxService

  const deviceId = new Types.ObjectId()
  const smsId = new Types.ObjectId()

  const mockDeviceModel = {
    find: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    }),
  }

  const mockSmsModel = {
    find: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0),
  }

  const mockSmsBatchModel = {
    findByIdAndUpdate: jest.fn(),
  }

  const mockWebhookService = {
    deliverNotification: jest.fn().mockResolvedValue(undefined),
  }

  const buildSms = (overrides: Record<string, any> = {}) => ({
    _id: smsId,
    user: 'user123',
    type: SMSType.SENT,
    status: 'pending',
    message: 'hello',
    recipient: '+639000000001',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    attemptCount: 0,
    maxAttempts: 5,
    excludedDeviceIds: [],
    ...overrides,
  })

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsOutboxService,
        { provide: getModelToken(Device.name), useValue: mockDeviceModel },
        { provide: getModelToken(SMS.name), useValue: mockSmsModel },
        { provide: getModelToken(SMSBatch.name), useValue: mockSmsBatchModel },
        { provide: WebhookService, useValue: mockWebhookService },
      ],
    }).compile()

    service = module.get<SmsOutboxService>(SmsOutboxService)
    jest.clearAllMocks()
    mockSmsModel.countDocuments.mockResolvedValue(0)
    mockDeviceModel.findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    })
  })

  describe('tryDispatchSms', () => {
    it('should hold the lease for the full handset deadline once FCM accepts', async () => {
      // A short claim lease left on a dispatched SMS makes the maintenance cron
      // treat an in-flight message as lost, re-sending it and refreshing
      // dispatchedAt so the 20m unknown fallback never fires.
      const device = {
        _id: deviceId,
        user: 'user123',
        enabled: true,
        fcmToken: 'token123',
        lastHeartbeat: new Date(),
      }
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.findById.mockResolvedValue(buildSms())
      mockSmsModel.findOneAndUpdate.mockResolvedValue(
        buildSms({ attemptCount: 1, device: deviceId }),
      )
      mockSmsModel.findByIdAndUpdate.mockResolvedValue(undefined)
      ;(firebaseAdmin.messaging as jest.Mock).mockReturnValue({
        sendEach: jest.fn().mockResolvedValue({
          responses: [{ success: true }],
          successCount: 1,
          failureCount: 0,
        }),
      })

      const before = Date.now()
      const result = await service.tryDispatchSms(smsId.toString())

      expect(result.status).toBe('dispatched')

      const dispatchUpdate = mockSmsModel.findByIdAndUpdate.mock.calls.find(
        (call) => call[1]?.$set?.status === 'dispatched',
      )
      expect(dispatchUpdate).toBeDefined()

      const leasedUntil: Date = dispatchUpdate[1].$set.leasedUntil
      const leaseWindow = leasedUntil.getTime() - before
      expect(leaseWindow).toBeGreaterThan(SMS_LEASE_MS)
      expect(leaseWindow).toBeLessThanOrEqual(SMS_DISPATCH_LEASE_MS + 5000)
    })
  })

  describe('listEligibleDevices assignment isolation', () => {
    const tayasanId = new Types.ObjectId()
    const evaaId = new Types.ObjectId()
    const sharedId = new Types.ObjectId()

    const tayasan = {
      _id: tayasanId,
      user: 'user123',
      enabled: true,
      fcmToken: 'tayasan-token',
      lastHeartbeat: new Date(),
      assignedTenantTag: 'ws_school_404617',
    }
    const evaa = {
      _id: evaaId,
      user: 'user123',
      enabled: true,
      fcmToken: 'evaa-token',
      lastHeartbeat: new Date(),
      assignedTenantTag: 'evaa',
    }
    const shared = {
      _id: sharedId,
      user: 'user123',
      enabled: true,
      fcmToken: 'shared-token',
      lastHeartbeat: new Date(),
    }

    it('does not fail over a Tayasan send onto an East Visayan dedicated phone', async () => {
      mockDeviceModel.find.mockResolvedValue([tayasan, evaa, shared])

      const devices = await service.listEligibleDevices('user123', {
        preferredDeviceId: tayasanId.toString(),
      })

      expect(devices.map((device) => device._id.toString())).toEqual([
        tayasanId.toString(),
      ])
    })

    it('keeps shared-pool sends on unassigned phones only', async () => {
      mockDeviceModel.find.mockResolvedValue([tayasan, evaa, shared])

      const devices = await service.listEligibleDevices('user123', {
        preferredDeviceId: sharedId.toString(),
      })

      expect(devices.map((device) => device._id.toString())).toEqual([
        sharedId.toString(),
      ])
    })
  })

  describe('claimForDevice assignment isolation', () => {
    it('does not let a dedicated phone claim another school\'s pending SMS', async () => {
      const evaaId = new Types.ObjectId()
      const tayasanId = new Types.ObjectId()
      const evaa = {
        _id: evaaId,
        user: 'user123',
        enabled: true,
        fcmToken: 'evaa-token',
        lastHeartbeat: new Date(),
        assignedTenantTag: 'evaa',
      }
      mockDeviceModel.findById.mockResolvedValue(evaa)
      mockDeviceModel.find.mockResolvedValue([evaa])
      mockSmsModel.findOneAndUpdate
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)

      const result = await service.claimForDevice(evaaId.toString(), 1)

      expect(result.claimed).toBe(0)
      const stealFilter = mockSmsModel.findOneAndUpdate.mock.calls[1][0]
      expect(JSON.stringify(stealFilter)).toContain(evaaId.toString())
      expect(JSON.stringify(stealFilter)).not.toContain(tayasanId.toString())
    })
  })

  describe('countWaitingOutbox', () => {
    it('should count only unleased, unexpired pending outbound SMS', async () => {
      mockSmsModel.countDocuments.mockResolvedValue(3)

      const count = await service.countWaitingOutbox('user123')

      expect(count).toBe(3)
      expect(mockSmsModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'user123',
          type: SMSType.SENT,
          status: 'pending',
        }),
      )
    })
  })
})
