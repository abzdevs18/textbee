import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { AuthGuard } from '../auth/guards/auth.guard'
import { GatewayController } from './gateway.controller'

describe('General push route boundary', () => {
  const pushes = {
    sendToAccount: jest.fn().mockResolvedValue({ accepted: true }),
  }
  const controller = new GatewayController({} as never, pushes as never)
  const input = {
    id: 'event-1',
    category: 'Attendance',
    title: 'Service issue',
    body: 'Open the console',
    severity: 'issue',
  }

  beforeEach(() => jest.clearAllMocks())

  it('loads without an optional transformer dependency and requires the existing authentication guard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      GatewayController.prototype.pushNotification,
    )
    expect(guards).toContain(AuthGuard)
  })

  it('derives recipients from the authenticated account and validates before dispatch', async () => {
    expect(
      await controller.pushNotification(
        { user: { _id: 'owner-account' } },
        input,
      ),
    ).toEqual({ data: { accepted: true } })
    expect(pushes.sendToAccount).toHaveBeenCalledWith(
      'owner-account',
      expect.objectContaining(input),
    )
    pushes.sendToAccount.mockClear()
    for (const extra of [
      { userId: 'another-account' },
      { recipients: ['other-device'] },
      JSON.parse('{"constructor":{}}'),
      JSON.parse('{"__proto__":{}}'),
    ]) {
      await expect(
        controller.pushNotification(
          { user: { _id: 'owner-account' } },
          { ...input, ...extra },
        ),
      ).rejects.toThrow('Invalid push notification')
    }
    expect(pushes.sendToAccount).not.toHaveBeenCalled()
  })
})
