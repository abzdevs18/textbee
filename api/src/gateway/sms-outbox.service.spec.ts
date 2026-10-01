import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { Types } from 'mongoose'
import * as firebaseAdmin from 'firebase-admin'
import {
  DispatchResult,
  SmsOutboxService,
  dispatchLeaseMsFor,
  maxInFlightFor,
} from './sms-outbox.service'
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

/**
 * Minimal Mongo-style matcher for the operators the outbox count queries use,
 * so capacity tests exercise the real filters instead of canned numbers.
 */
function matchesFilter(row: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return (condition as any[]).some((c) => matchesFilter(row, c))
    if (key === '$and') return (condition as any[]).every((c) => matchesFilter(row, c))
    const value = row[key]
    if (condition === null) return value === null || value === undefined
    if (
      condition &&
      typeof condition === 'object' &&
      !(condition instanceof Date) &&
      !(condition instanceof Types.ObjectId) &&
      !Array.isArray(condition)
    ) {
      return Object.entries(condition).every(([op, arg]: [string, any]) => {
        switch (op) {
          case '$gt':
            return value != null && value > arg
          case '$gte':
            return value != null && value >= arg
          case '$lt':
            return value != null && value < arg
          case '$lte':
            return value != null && value <= arg
          case '$in':
            return arg.map(String).includes(String(value))
          case '$nin':
            return !arg.map(String).includes(String(value))
          case '$exists':
            return (value !== undefined) === arg
          default:
            throw new Error(`matchesFilter: unsupported operator ${op}`)
        }
      })
    }
    return String(value) === String(condition)
  })
}

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

    it('keeps a pending Tayasan SMS bound to Tayasan after its preferred phone is reassigned', async () => {
      const replacementTayasanId = new Types.ObjectId()
      const reassignedPreferred = {
        ...tayasan,
        assignedTenantTag: 'evaa',
      }
      const replacementTayasan = {
        ...tayasan,
        _id: replacementTayasanId,
        fcmToken: 'replacement-tayasan-token',
      }
      mockDeviceModel.find.mockResolvedValue([
        reassignedPreferred,
        evaa,
        replacementTayasan,
        shared,
      ])

      const devices = await service.listEligibleDevices('user123', {
        preferredDeviceId: tayasanId.toString(),
        tenantTag: 'ws_school_404617',
      })
      const ids = devices.map((device) => device._id.toString())

      expect(ids).toEqual([replacementTayasanId.toString()])
      expect(ids).not.toContain(tayasanId.toString())
      expect(ids).not.toContain(evaaId.toString())
      expect(ids).not.toContain(sharedId.toString())
    })

    it('uses the shared pool only when no device is currently dedicated to the message tenant', async () => {
      mockDeviceModel.find.mockResolvedValue([
        { ...tayasan, assignedTenantTag: 'evaa' },
        evaa,
        shared,
      ])

      const devices = await service.listEligibleDevices('user123', {
        preferredDeviceId: tayasanId.toString(),
        tenantTag: 'ws_school_404617',
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
      const regexes: RegExp[] = []
      const collectRegexes = (value: any): void => {
        if (value instanceof RegExp) {
          regexes.push(value)
          return
        }
        if (Array.isArray(value)) {
          value.forEach(collectRegexes)
          return
        }
        if (value && typeof value === 'object') {
          Object.values(value).forEach(collectRegexes)
        }
      }
      collectRegexes(stealFilter)
      expect(regexes.map((regex) => regex.source)).toContain('^evaa$')
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
      expect(JSON.stringify(mockSmsModel.countDocuments.mock.calls[0][0])).toContain(
        'nextAttemptAt',
      )
    })
  })

  describe('device capacity (in-flight deadlock regression)', () => {
    const seedCounts = (rows: Record<string, any>[]) => {
      mockSmsModel.countDocuments.mockImplementation(async (filter: any) =>
        rows.filter((row) => matchesFilter(row, filter)).length,
      )
    }
    const sentRow = (overrides: Record<string, any>) => ({
      user: 'user123',
      device: deviceId,
      type: SMSType.SENT,
      ...overrides,
    })

    it('does not count waiting rows that were never handed to the phone', async () => {
      // Six queued rows assigned to the phone used to exceed the cap of 5 and
      // lock it out of both push dispatch and claim-outbox until the 2h cancel.
      seedCounts([
        ...Array.from({ length: 6 }, () => sentRow({ status: 'pending' })),
        sentRow({ status: 'dispatched', leasedUntil: new Date(Date.now() + 60_000) }),
      ])

      const summary = await service.getDeviceHealthSummary(deviceId.toString(), 'user123')

      expect(summary.inFlight).toBe(1)
      expect(summary.isPaused).toBe(false)
    })

    it('still pauses a phone that genuinely holds a full load', async () => {
      seedCounts([
        ...Array.from({ length: 4 }, () =>
          sentRow({ status: 'dispatched', leasedUntil: new Date(Date.now() + 60_000) }),
        ),
        sentRow({ status: 'pending', leasedUntil: new Date(Date.now() + 60_000) }),
        // expired lease: about to be reclaimed, no longer held
        sentRow({ status: 'dispatched', leasedUntil: new Date(Date.now() - 1_000) }),
      ])

      const summary = await service.getDeviceHealthSummary(deviceId.toString(), 'user123')

      expect(summary.inFlight).toBe(5)
      expect(summary.isPaused).toBe(true)
    })
  })

  describe('claimForDevice pull path', () => {
    const device = {
      _id: deviceId,
      user: 'user123',
      enabled: true,
      fcmToken: 'token123',
      lastHeartbeat: new Date(),
    }

    it('claims for a phone whose FCM token is flagged invalid', async () => {
      // The phone pulling is proof it is online; push health is irrelevant.
      const flagged = { ...device, fcmTokenInvalidatedAt: new Date() }
      mockDeviceModel.findById.mockResolvedValue(flagged)
      mockDeviceModel.find.mockResolvedValue([flagged])
      mockSmsModel.findOneAndUpdate
        .mockResolvedValueOnce(buildSms({ attemptCount: 2, device: deviceId }))
        .mockResolvedValue(null)
      mockSmsModel.findByIdAndUpdate.mockResolvedValue(undefined)

      const result = await service.claimForDevice(deviceId.toString(), 5)

      expect(result.claimed).toBe(1)
      expect(result.messages[0]).toEqual(
        expect.objectContaining({
          smsId: smsId.toString(),
          targetDeviceId: deviceId.toString(),
          attempt: 2,
          issuedAt: expect.any(String),
        }),
      )
      const [, dispatchUpdate] = mockSmsModel.findByIdAndUpdate.mock.calls[0]
      expect(dispatchUpdate.$set.status).toBe('dispatched')
      expect(dispatchUpdate.$push['metadata.dispatchAttempts']).toEqual(
        expect.objectContaining({ deviceId: deviceId.toString(), via: 'claim' }),
      )
    })

    it('re-delivers work the phone already holds when asked to resync', async () => {
      mockDeviceModel.findById.mockResolvedValue(device)
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.find.mockResolvedValue([
        buildSms({
          status: 'dispatched',
          attemptCount: 1,
          device: deviceId,
          leasedUntil: new Date(Date.now() + 60_000),
        }),
      ])
      mockSmsModel.findOneAndUpdate.mockResolvedValue(null)

      const result = await service.claimForDevice(deviceId.toString(), 5, {
        resync: true,
      })

      expect(result).toEqual(
        expect.objectContaining({ claimed: 0, redelivered: 1 }),
      )
      expect(result.messages[0]).toEqual(
        expect.objectContaining({ smsId: smsId.toString(), attempt: 1 }),
      )
      const [heldFilter] = mockSmsModel.find.mock.calls[0]
      expect(heldFilter).toEqual(
        expect.objectContaining({ device: deviceId, status: 'dispatched' }),
      )
    })

    it('does not re-deliver held work to clients that did not ask for it', async () => {
      mockDeviceModel.findById.mockResolvedValue(device)
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.findOneAndUpdate.mockResolvedValue(null)

      const result = await service.claimForDevice(deviceId.toString(), 5)

      expect(result.redelivered).toBe(0)
      expect(mockSmsModel.find).not.toHaveBeenCalled()
    })
  })

  describe('tryDispatchSms failure handling', () => {
    const device = {
      _id: deviceId,
      user: 'user123',
      enabled: true,
      fcmToken: 'token123',
      lastHeartbeat: new Date(),
    }

    it('keeps the SMS claimable and gives the attempt back when FCM rejects the token', async () => {
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.findById.mockResolvedValue(buildSms())
      mockSmsModel.findOneAndUpdate
        .mockResolvedValueOnce(buildSms({ attemptCount: 1, device: deviceId }))
        .mockResolvedValue(undefined)
      ;(firebaseAdmin.messaging as jest.Mock).mockReturnValue({
        sendEach: jest.fn().mockResolvedValue({
          responses: [
            {
              success: false,
              error: {
                code: 'messaging/registration-token-not-registered',
                message: 'Requested entity was not found.',
              },
            },
          ],
          successCount: 0,
          failureCount: 1,
        }),
      })

      const result = await service.tryDispatchSms(smsId.toString())

      expect(result.status).toBe('pending')
      expect(mockDeviceModel.findByIdAndUpdate).toHaveBeenCalledWith(
        deviceId.toString(),
        expect.objectContaining({
          $set: expect.objectContaining({
            fcmTokenInvalidReason: 'FCM_TOKEN_NOT_REGISTERED',
          }),
        }),
      )
      const [, release] = mockSmsModel.findOneAndUpdate.mock.calls[1]
      // Excluding the phone here used to hide the SMS from its own pull loop.
      expect(release.$addToSet).toBeUndefined()
      expect(release.$inc).toEqual({ attemptCount: -1 })
      expect(release.$set['metadata.lastPushFailure']).toEqual(
        expect.objectContaining({ errorCode: 'FCM_TOKEN_NOT_REGISTERED' }),
      )
    })

    it('does not blame the device token for payload errors', async () => {
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.findById.mockResolvedValue(buildSms())
      mockSmsModel.findOneAndUpdate
        .mockResolvedValueOnce(buildSms({ attemptCount: 1, device: deviceId }))
        .mockResolvedValue(undefined)
      ;(firebaseAdmin.messaging as jest.Mock).mockReturnValue({
        sendEach: jest.fn().mockResolvedValue({
          responses: [
            {
              success: false,
              error: {
                code: 'messaging/invalid-argument',
                message: 'Android message is too big',
              },
            },
          ],
          successCount: 0,
          failureCount: 1,
        }),
      })

      await service.tryDispatchSms(smsId.toString())

      const flagged = mockDeviceModel.findByIdAndUpdate.mock.calls.find(
        (call) => call[1]?.$set?.fcmTokenInvalidatedAt,
      )
      expect(flagged).toBeUndefined()
    })

    it('never $sets and $unsets the same path when no device is eligible', async () => {
      // MongoDB rejects such updates ("would create a conflict"), which made
      // sendSMS return 500 and aborted the outbox maintenance cron.
      mockDeviceModel.find.mockResolvedValue([])
      mockSmsModel.findById.mockResolvedValue(buildSms())
      mockSmsModel.findByIdAndUpdate.mockResolvedValue(undefined)

      const result = await service.tryDispatchSms(smsId.toString())

      expect(result).toEqual(
        expect.objectContaining({ status: 'pending', reason: 'NO_ELIGIBLE_DEVICE' }),
      )
      const [, update] = mockSmsModel.findByIdAndUpdate.mock.calls[0]
      expect(update.$set.errorCode).toBe('NO_ELIGIBLE_DEVICE')
      const overlap = Object.keys(update.$set).filter((key) =>
        Object.prototype.hasOwnProperty.call(update.$unset || {}, key),
      )
      expect(overlap).toEqual([])
    })

    it('holds off while a retry backoff is running', async () => {
      mockSmsModel.findById.mockResolvedValue(
        buildSms({ nextAttemptAt: new Date(Date.now() + 60_000) }),
      )

      const result = await service.tryDispatchSms(smsId.toString())

      expect(result).toEqual(
        expect.objectContaining({ status: 'pending', reason: 'RETRY_BACKOFF' }),
      )
      expect(mockSmsModel.findOneAndUpdate).not.toHaveBeenCalled()
    })
  })

  describe('handleSendFailureAndFailover on a single phone', () => {
    const device = {
      _id: deviceId,
      user: 'user123',
      enabled: true,
      fcmToken: 'token123',
      lastHeartbeat: new Date(),
    }
    const failedSms = () =>
      buildSms({
        status: 'dispatched',
        device: deviceId,
        preferredDevice: deviceId,
        attemptCount: 1,
      })

    beforeEach(() => {
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.findById.mockResolvedValue(failedSms())
      mockSmsModel.findByIdAndUpdate.mockResolvedValue(undefined)
      ;(firebaseAdmin.messaging as jest.Mock).mockReturnValue({
        sendEach: jest.fn().mockResolvedValue({ responses: [], successCount: 0, failureCount: 0 }),
      })
    })

    it('schedules a backoff retry on the same phone for a transient radio error', async () => {
      const before = Date.now()
      const result = await service.handleSendFailureAndFailover(
        smsId.toString(),
        deviceId.toString(),
        '4', // RESULT_ERROR_NO_SERVICE
        'No cellular service',
      )

      expect(result).toEqual(
        expect.objectContaining({ status: 'pending', reason: 'RETRY_SCHEDULED' }),
      )
      const retryUpdate = mockSmsModel.findByIdAndUpdate.mock.calls.find(
        (call) => call[1]?.$set?.nextAttemptAt,
      )
      expect(retryUpdate).toBeDefined()
      expect(String(retryUpdate[1].$pull.excludedDeviceIds)).toBe(deviceId.toString())
      const delay = retryUpdate[1].$set.nextAttemptAt.getTime() - before
      expect(delay).toBeGreaterThanOrEqual(55_000)
      expect(delay).toBeLessThanOrEqual(65_000)
    })

    it('fails visibly instead of pending forever on a permanent error', async () => {
      const result = await service.handleSendFailureAndFailover(
        smsId.toString(),
        deviceId.toString(),
        'PERMISSION_DENIED',
        'SMS permission not granted',
      )

      expect(result).toEqual(expect.objectContaining({ status: 'failed' }))
      const failUpdate = mockSmsModel.findByIdAndUpdate.mock.calls.find(
        (call) => call[1]?.$set?.status === 'failed',
      )
      expect(failUpdate).toBeDefined()
    })

    it('does not re-exclude the only phone when the same failure is reported again during the backoff', async () => {
      // 2.8.19 phones send one FAILED per multipart part; a retried report can
      // also arrive twice. The second must not strand the SMS.
      mockSmsModel.findById.mockResolvedValue(
        buildSms({
          status: 'pending',
          device: deviceId,
          preferredDevice: deviceId,
          attemptCount: 1,
          nextAttemptAt: new Date(Date.now() + 60_000),
        }),
      )

      const result = await service.handleSendFailureAndFailover(
        smsId.toString(),
        deviceId.toString(),
        '1',
        'Generic failure',
      )

      expect(result).toEqual(
        expect.objectContaining({ status: 'pending', reason: 'RETRY_BACKOFF' }),
      )
      const excluded = mockSmsModel.findByIdAndUpdate.mock.calls.find(
        (call) => call[1]?.$addToSet?.excludedDeviceIds,
      )
      expect(excluded).toBeUndefined()
    })

    it('ignores a phone that stopped checking in when deciding whether to retry here', async () => {
      // An enabled row for a phone that is off (or the row a reinstall left
      // behind) never pulls; counting it used to skip the retry entirely.
      const staleId = new Types.ObjectId()
      const stale = {
        ...device,
        _id: staleId,
        fcmToken: 'stale-token',
        lastHeartbeat: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      }
      mockDeviceModel.find.mockResolvedValue([device, stale])
      // The stale phone cannot take the SMS by push either (cooldown)...
      mockSmsModel.countDocuments.mockImplementation(async (filter: any) =>
        String(filter.device) === staleId.toString() ? 5 : 0,
      )

      const result = await service.handleSendFailureAndFailover(
        smsId.toString(),
        deviceId.toString(),
        '4',
        'No cellular service',
      )

      // ...so the live phone that failed gets a backoff retry.
      expect(result).toEqual(
        expect.objectContaining({ status: 'pending', reason: 'RETRY_SCHEDULED' }),
      )
    })

    it('waits for another phone that is merely busy instead of retrying here', async () => {
      const otherId = new Types.ObjectId()
      const other = { ...device, _id: otherId, fcmToken: 'other-token' }
      mockDeviceModel.find.mockResolvedValue([device, other])
      // The other phone holds a full load, so it cannot take the SMS right now.
      mockSmsModel.countDocuments.mockImplementation(async (filter: any) =>
        String(filter.device) === otherId.toString() ? 5 : 0,
      )

      const result = await service.handleSendFailureAndFailover(
        smsId.toString(),
        deviceId.toString(),
        '4',
        'No cellular service',
      )

      expect(result).toEqual(
        expect.objectContaining({ status: 'pending', reason: 'NO_ELIGIBLE_DEVICE' }),
      )
      const retryUpdate = mockSmsModel.findByIdAndUpdate.mock.calls.find(
        (call) => call[1]?.$set?.nextAttemptAt,
      )
      expect(retryUpdate).toBeUndefined()
    })
  })

  describe('pacing-aware leases', () => {
    it('lets a phone hold only what it can send well inside its lease', () => {
      expect(maxInFlightFor({ smsSendDelaySeconds: 5 })).toBe(5)
      expect(dispatchLeaseMsFor({ smsSendDelaySeconds: 5 })).toBe(SMS_DISPATCH_LEASE_MS)

      expect(maxInFlightFor({ smsSendDelaySeconds: 120 })).toBe(2)
      expect(maxInFlightFor({ smsSendDelaySeconds: 300 })).toBe(1)

      // Delays longer than the default lease stretch the lease instead.
      expect(maxInFlightFor({ smsSendDelaySeconds: 600 })).toBe(1)
      expect(dispatchLeaseMsFor({ smsSendDelaySeconds: 600 })).toBe(20 * 60 * 1000)

      expect(maxInFlightFor({})).toBe(5)
      expect(dispatchLeaseMsFor({})).toBe(SMS_DISPATCH_LEASE_MS)
    })

    it('stops dispatching to a slow-paced phone once it holds what it can send', async () => {
      const slow = {
        _id: deviceId,
        user: 'user123',
        enabled: true,
        fcmToken: 'token123',
        lastHeartbeat: new Date(),
        smsSendDelaySeconds: 300,
      }
      mockSmsModel.countDocuments.mockResolvedValue(1)

      const check = await service.isDeviceEligible(slow, 'user123')

      expect(check.eligible).toBe(false)
      expect(check.reason).toContain('1/1')
    })

    it('tells the phone when its lease ends and keeps the existing lease on resync', async () => {
      const leasedUntil = new Date(Date.now() + 4 * 60 * 1000)
      const device = {
        _id: deviceId,
        user: 'user123',
        enabled: true,
        fcmToken: 'token123',
        lastHeartbeat: new Date(),
      }
      mockDeviceModel.findById.mockResolvedValue(device)
      mockDeviceModel.find.mockResolvedValue([device])
      mockSmsModel.find.mockResolvedValue([
        buildSms({ status: 'dispatched', attemptCount: 1, device: deviceId, leasedUntil }),
      ])
      mockSmsModel.findOneAndUpdate.mockResolvedValue(null)

      const result = await service.claimForDevice(deviceId.toString(), 5, { resync: true })

      expect(result.messages[0].leaseUntil).toBe(leasedUntil.toISOString())
      // The pull itself refreshes liveness.
      expect(mockDeviceModel.findByIdAndUpdate).toHaveBeenCalledWith(
        deviceId,
        { $set: { lastHeartbeat: expect.any(Date) } },
      )
    })
  })

  describe('buildFcmMessage', () => {
    it('bounds FCM lifetime and carries attempt identity and server time', () => {
      const sms = buildSms({
        attemptCount: 3,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })

      const message: any = service.buildFcmMessage(sms, {
        _id: deviceId,
        fcmToken: 'token123',
      })

      expect(message.android.priority).toBe('high')
      expect(message.android.ttl).toBeGreaterThan(0)
      expect(message.android.ttl).toBeLessThanOrEqual(SMS_DISPATCH_LEASE_MS)
      const payload = JSON.parse(message.data.smsData)
      expect(payload).toEqual(
        expect.objectContaining({
          smsId: smsId.toString(),
          attempt: 3,
          issuedAt: expect.any(String),
          expiresAt: sms.expiresAt.toISOString(),
        }),
      )
    })

    it('never lets a command outlive the SMS itself', () => {
      const sms = buildSms({ expiresAt: new Date(Date.now() + 30_000) })

      const message: any = service.buildFcmMessage(sms, {
        _id: deviceId,
        fcmToken: 'token123',
      })

      expect(message.android.ttl).toBeLessThanOrEqual(30_000)
    })
  })

  describe('dispatchWaitingOutbox', () => {
    it('skips the rest of a route that just found no device and keeps draining others', async () => {
      const blockedA = new Types.ObjectId()
      const blockedB = new Types.ObjectId()
      const otherSchool = new Types.ObjectId()
      const deadPhone = new Types.ObjectId()
      const livePhone = new Types.ObjectId()
      const chain: any = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { _id: blockedA, user: 'u1', preferredDevice: deadPhone },
          { _id: blockedB, user: 'u1', preferredDevice: deadPhone },
          { _id: otherSchool, user: 'u1', preferredDevice: livePhone },
        ]),
      }
      mockSmsModel.find.mockReturnValue(chain)
      const trySpy = jest
        .spyOn(service, 'tryDispatchSms')
        .mockImplementation(
          async (id: string): Promise<DispatchResult> =>
            id === blockedA.toString()
              ? { smsId: id, status: 'pending', reason: 'NO_ELIGIBLE_DEVICE' }
              : { smsId: id, status: 'dispatched' },
        )

      const dispatched = await service.dispatchWaitingOutbox(10)

      expect(trySpy.mock.calls.map((call) => call[0])).toEqual([
        blockedA.toString(),
        otherSchool.toString(),
      ])
      expect(dispatched).toBe(1)
      expect(JSON.stringify(mockSmsModel.find.mock.calls[0][0])).toContain(
        'nextAttemptAt',
      )
      trySpy.mockRestore()
    })
  })
})
