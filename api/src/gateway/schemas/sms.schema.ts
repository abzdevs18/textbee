import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'
import { Device } from './device.schema'
import { SMSBatch } from './sms-batch.schema'
import { User } from '../../users/schemas/user.schema'

export type SMSDocument = SMS & Document

@Schema({ timestamps: true })
export class SMS {
  _id?: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: User.name, required: true, index: true })
  user: User | Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: Device.name, required: true })
  device: Device | Types.ObjectId

  /** Preferred device at enqueue time; outbox may assign a different free device. */
  @Prop({ type: Types.ObjectId, ref: Device.name, required: false, index: true })
  preferredDevice?: Device | Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: SMSBatch.name })
  smsBatch: SMSBatch | Types.ObjectId

  @Prop({ type: String })
  message: string

  @Prop({ type: Boolean, default: false })
  encrypted: boolean

  @Prop({ type: String })
  encryptedMessage: string

  @Prop({ type: String, required: true })
  type: string

  // fields for incoming messages
  @Prop({ type: String })
  sender: string

  @Prop({ type: Date })
  receivedAt: Date

  // fields for outgoing messages
  @Prop({ type: String })
  recipient: string

  @Prop({ type: Date })
  requestedAt: Date

  @Prop({ type: Date })
  queuedAt: Date

  @Prop({ type: Date })
  scheduledAt: Date

  /** Hard deadline — never send after this (2h policy). */
  @Prop({ type: Date, index: true })
  expiresAt: Date

  @Prop({ type: String })
  queueJobId: string

  /** Claim/lease so only one device holds the SMS at a time. */
  @Prop({ type: Date, index: true })
  leasedUntil: Date

  @Prop({ type: Date })
  leasedAt: Date

  @Prop({ type: Number, default: 0 })
  attemptCount: number

  @Prop({ type: Number, default: 5 })
  maxAttempts: number

  /** Device ids that already failed this SMS (skip on next pick). */
  @Prop({ type: [Types.ObjectId], default: [] })
  excludedDeviceIds: Types.ObjectId[]

  @Prop({ type: Date })
  dispatchedAt: Date

  @Prop({ type: Date })
  sentAt: Date

  @Prop({ type: Date })
  deliveredAt: Date

  @Prop({ type: Date })
  failedAt: Date

  @Prop({ type: Date })
  canceledAt: Date

  @Prop({ type: Date, index: true })
  hiddenAt: Date
  
  @Prop({ type: String, required: false })
  errorCode: string

  @Prop({ type: String, required: false })
  errorMessage: string

  @Prop({ type: String, default: 'pending' })
  status:
    | 'pending'
    | 'dispatched'
    | 'sent'
    | 'delivered'
    | 'failed'
    | 'unknown'
    | 'received'
    | 'canceled'

  @Prop({ type: Number, required: false })
  simSubscriptionId?: number

  // misc metadata for debugging
  @Prop({ type: Object })
  metadata: Record<string, any>
}

export const SMSSchema = SchemaFactory.createForClass(SMS)


SMSSchema.index({ device: 1, type: 1, receivedAt: -1 })
SMSSchema.index({ user: 1, createdAt: -1, type: 1 })
SMSSchema.index({ user: 1, status: 1, createdAt: -1 })
SMSSchema.index({ queueJobId: 1 })
// Central outbox: oldest pending first for claim/dispatch
SMSSchema.index({
  status: 1,
  type: 1,
  expiresAt: 1,
  leasedUntil: 1,
  requestedAt: 1,
})
SMSSchema.index({ user: 1, status: 1, type: 1, preferredDevice: 1, requestedAt: 1 })
