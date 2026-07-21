import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { SmsStatusUpdateTask } from './sms-status-update.task'
import { SMS } from '../schemas/sms.schema'
import { SMSBatch } from '../schemas/sms-batch.schema'
import { Model } from 'mongoose'
import { SmsOutboxService } from '../sms-outbox.service'

describe('SmsStatusUpdateTask', () => {
  let task: SmsStatusUpdateTask
  let smsModel: Model<SMS>
  let smsBatchModel: Model<SMSBatch>

  const mockOutbox = {
    cancelAllExpired: jest.fn().mockResolvedValue(0),
    reclaimExpiredLeases: jest.fn().mockResolvedValue(0),
    dispatchWaitingOutbox: jest.fn().mockResolvedValue(0),
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmsStatusUpdateTask,
        {
          provide: getModelToken(SMS.name),
          useValue: {
            updateMany: jest.fn().mockResolvedValue({ modifiedCount: 5 }),
          },
        },
        {
          provide: getModelToken(SMSBatch.name),
          useValue: {
            updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
          },
        },
        {
          provide: SmsOutboxService,
          useValue: mockOutbox,
        },
      ],
    }).compile()

    task = module.get<SmsStatusUpdateTask>(SmsStatusUpdateTask)
    smsModel = module.get<Model<SMS>>(getModelToken(SMS.name))
    smsBatchModel = module.get<Model<SMSBatch>>(getModelToken(SMSBatch.name))
  })

  it('should be defined', () => {
    expect(task).toBeDefined()
  })

  describe('handleOutboxMaintenance', () => {
    it('should cancel expired, reclaim leases, and dispatch waiting', async () => {
      await task.handleOutboxMaintenance()
      expect(mockOutbox.cancelAllExpired).toHaveBeenCalled()
      expect(mockOutbox.reclaimExpiredLeases).toHaveBeenCalled()
      expect(mockOutbox.dispatchWaitingOutbox).toHaveBeenCalledWith(100)
    })
  })

  describe('handlePendingSmsTimeout', () => {
    it('should update stale dispatched SMS to unknown', async () => {
      await task.handlePendingSmsTimeout()

      expect(smsModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'dispatched',
          dispatchedAt: expect.any(Object),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'unknown',
          }),
        }),
      )

      expect(smsBatchModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          createdAt: expect.any(Object),
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'unknown',
          }),
        }),
      )
    })
  })
})
