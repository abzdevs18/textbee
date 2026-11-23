import { PushNotificationService } from './push-notification.service'
import {
  PushNotificationDTO,
  parsePushNotification,
} from './push-notification.dto'
import { validate } from 'class-validator'
import * as firebase from 'firebase-admin'

jest.mock('firebase-admin', () => ({ messaging: jest.fn() }))
const input: PushNotificationDTO = {
  id: 'alert-1',
  category: 'Gradesheet',
  title: 'Service degraded',
  body: 'Open the owner console',
  severity: 'degraded',
  url: 'https://app.example.test/admin/service-status',
}
describe('Account-wide app push notifications', () => {
  const sendEach = jest.fn()
  const exec = jest.fn()
  const query = {
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec,
  }
  const devices = { find: jest.fn(() => query) }
  const service = new PushNotificationService(devices as never)
  beforeEach(() => {
    jest.clearAllMocks()
    ;(firebase.messaging as jest.Mock).mockReturnValue({ sendEach })
    exec.mockResolvedValue([
      { _id: 'device-a', fcmToken: 'token-a' },
      { _id: 'device-b', fcmToken: 'token-b' },
    ])
    sendEach.mockResolvedValue({ successCount: 2, failureCount: 0 })
  })
  it('targets only the authenticated account, includes all registered tokens and bypasses SMS queues', async () => {
    expect(await service.sendToAccount('owner-a', input)).toEqual({
      accepted: true,
      recipients: 2,
      unreachable: 0,
      delivered: false,
    })
    expect(devices.find).toHaveBeenCalledWith({
      user: 'owner-a',
      fcmToken: { $type: 'string', $ne: '' },
    })
    const messages = sendEach.mock.calls[0][0]
    expect(messages.map((m) => m.token)).toEqual(['token-a', 'token-b'])
    expect(messages[0]).toMatchObject({
      data: { type: 'platform_alert', title: input.title },
      android: { priority: 'high', ttl: 300000 },
    })
    expect(messages[0].data).not.toHaveProperty('smsData')
    expect(messages[0].data.alertId).not.toBe(messages[1].data.alertId)
  })
  it('uses stable alert IDs across partial-broadcast retries', async () => {
    sendEach.mockResolvedValueOnce({ successCount: 1, failureCount: 1 })
    await expect(service.sendToAccount('owner-a', input)).rejects.toThrow(
      'could not be accepted',
    )
    await service.sendToAccount('owner-a', input)
    expect(sendEach.mock.calls[0][0][0].data.alertId).toBe(
      sendEach.mock.calls[1][0][0].data.alertId,
    )
  })
  it('keeps stale registrations from blocking healthy recipients', async () => {
    sendEach.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: 'messaging/registration-token-not-registered' },
        },
      ],
    })
    expect(await service.sendToAccount('owner-a', input)).toMatchObject({
      accepted: true,
      recipients: 1,
      unreachable: 1,
    })
  })
  it('rejects missing recipients and never exposes Firebase credentials in errors', async () => {
    exec.mockResolvedValueOnce([])
    await expect(service.sendToAccount('owner-a', input)).rejects.toThrow(
      'No registered',
    )
    sendEach.mockRejectedValueOnce(new Error('PRIVATE token-a'))
    await expect(service.sendToAccount('owner-a', input)).rejects.toThrow(
      'Push broadcast could not be accepted',
    )
  })
  it('validates bounded text, HTTPS links and forbids unknown fields at the route boundary', async () => {
    const good = Object.assign(new PushNotificationDTO(), input)
    expect(
      await validate(good, { whitelist: true, forbidNonWhitelisted: true }),
    ).toHaveLength(0)
    for (const invalid of [
      { body: 'a'.repeat(321) },
      { url: 'javascript:alert(1)' },
      { url: 'https://user:password@example.test' },
      { payload: { scores: [] } },
      { severity: 'arbitrary' },
    ]) {
      const bad = Object.assign(new PushNotificationDTO(), input, invalid)
      expect(
        (await validate(bad, { whitelist: true, forbidNonWhitelisted: true }))
          .length,
      ).toBeGreaterThan(0)
      expect(() => parsePushNotification({ ...input, ...invalid })).toThrow(
        'Invalid push notification',
      )
    }
    expect(parsePushNotification(input)).toBeInstanceOf(PushNotificationDTO)
    for (const invalid of [null, [], 'text', 42])
      expect(() => parsePushNotification(invalid)).toThrow(
        'Invalid push notification',
      )
  })
})
