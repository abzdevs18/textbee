import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import * as firebase from 'firebase-admin'
import { AuthGuard } from '../../auth/guards/auth.guard'
import { CanModifyDevice } from '../guards/can-modify-device.guard'
import { RemoteScreenController } from './remote-screen.controller'
import {
  parseRemoteScreenCommand,
  parseRemoteScreenFrame,
  parseRemoteScreenStatus,
} from './remote-screen.dto'
import { RemoteScreenService } from './remote-screen.service'
import { MemoryRemoteScreenStore } from './remote-screen.store'

jest.mock('firebase-admin', () => {
  const send = jest.fn().mockResolvedValue('message-id')
  return { messaging: () => ({ send }), __send: send }
})

const send = (firebase as unknown as { __send: jest.Mock }).__send
const DEVICE = '64b7f0c2a1b2c3d4e5f60718'
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD'

function devicesModel(device: unknown) {
  const exec = jest.fn().mockResolvedValue(device)
  const chain = { select: () => chain, lean: () => chain, exec }
  return { findById: jest.fn(() => chain) }
}

describe('RemoteScreenService', () => {
  let store: MemoryRemoteScreenStore
  let service: RemoteScreenService

  beforeEach(() => {
    send.mockClear()
    store = new MemoryRemoteScreenStore()
    service = new RemoteScreenService(
      store,
      devicesModel({ _id: DEVICE, fcmToken: 'token-1' }) as never,
    )
  })

  it('starts a session, wakes the phone and reuses the session on retry', async () => {
    const first = await service.start(DEVICE, 'owner')
    expect(first.sessionId).toMatch(/^[a-f0-9]{32}$/)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token-1',
        data: expect.objectContaining({
          type: 'remote_screen',
          action: 'start',
          sessionId: first.sessionId,
          targetDeviceId: DEVICE,
        }),
      }),
    )
    const second = await service.start(DEVICE, 'owner')
    expect(second.sessionId).toBe(first.sessionId)
    expect(send).toHaveBeenCalledTimes(2)
    expect((await service.view(DEVICE)).status?.state).toBe('starting')
  })

  it('refuses to start when the phone has no push token', async () => {
    service = new RemoteScreenService(
      store,
      devicesModel({ _id: DEVICE }) as never,
    )
    await expect(service.start(DEVICE, 'owner')).rejects.toThrow('push token')
  })

  it('round-trips frames and taps between phone and viewer', async () => {
    const { sessionId } = await service.start(DEVICE, 'owner')
    await service.queueCommand(DEVICE, { type: 'tap', x: 0.5, y: 0.8 })

    const reply = await service.acceptFrame(DEVICE, {
      sessionId,
      width: 720,
      height: 1600,
      image: JPEG,
    })
    expect(reply).toEqual({
      active: true,
      commands: [{ type: 'tap', x: 0.5, y: 0.8 }],
    })
    // Commands are delivered once.
    expect(
      (await service.acceptFrame(DEVICE, { sessionId, width: 720, height: 1600, image: JPEG }))
        .commands,
    ).toEqual([])

    // "Screen unchanged" keep-alive: still collects input, keeps the old frame.
    await service.queueCommand(DEVICE, { type: 'global', action: 'back' })
    expect(await service.acceptFrame(DEVICE, { sessionId })).toEqual({
      active: true,
      commands: [{ type: 'global', action: 'back' }],
    })

    const view = await service.view(DEVICE)
    expect(view.status?.state).toBe('streaming')
    expect(view.frame?.image).toBe(JPEG)
    // A viewer that already has this frame gets metadata only.
    const unchanged = await service.view(DEVICE, view.frame!.capturedAt)
    expect(unchanged.frame?.image).toBe('')
  })

  it('tells the phone to stop when the session is gone or belongs to someone else', async () => {
    const { sessionId } = await service.start(DEVICE, 'owner')
    expect(
      (await service.acceptFrame(DEVICE, {
        sessionId: 'f'.repeat(32),
        width: 100,
        height: 100,
        image: JPEG,
      })).active,
    ).toBe(false)
    await service.stop(DEVICE)
    expect(
      (await service.acceptFrame(DEVICE, { sessionId, width: 100, height: 100, image: JPEG }))
        .active,
    ).toBe(false)
    expect((await service.view(DEVICE)).active).toBe(false)
    await expect(
      service.queueCommand(DEVICE, { type: 'global', action: 'back' }),
    ).rejects.toThrow('No active remote screen session')
  })

  it('caps queued input', async () => {
    await service.start(DEVICE, 'owner')
    for (let i = 0; i < 20; i++)
      await service.queueCommand(DEVICE, { type: 'tap', x: 0, y: 0 })
    await expect(
      service.queueCommand(DEVICE, { type: 'tap', x: 0, y: 0 }),
    ).rejects.toThrow('wait a moment')
  })

  it('records why the phone cannot stream', async () => {
    const { sessionId } = await service.start(DEVICE, 'owner')
    await service.acceptStatus(DEVICE, {
      sessionId,
      state: 'accessibility_disabled',
    })
    expect((await service.view(DEVICE)).status?.state).toBe('accessibility_disabled')
  })
})

describe('Remote screen input parsing', () => {
  it('accepts well-formed commands', () => {
    expect(parseRemoteScreenCommand({ type: 'tap', x: 0.1, y: 1 })).toEqual({
      type: 'tap',
      x: 0.1,
      y: 1,
    })
    expect(
      parseRemoteScreenCommand({ type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1 }),
    ).toEqual({ type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 300 })
    expect(parseRemoteScreenCommand({ type: 'global', action: 'home' })).toEqual({
      type: 'global',
      action: 'home',
    })
  })

  it.each([
    null,
    [],
    { type: 'tap', x: 2, y: 0 },
    { type: 'tap', x: '0.5', y: 0 },
    { type: 'tap', x: 0.5, y: 0.5, extra: true },
    { type: 'global', action: 'power' },
    { type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 60000 },
    { type: 'shell', command: 'reboot' },
    JSON.parse('{"__proto__":{"type":"tap"}}'),
  ])('rejects %j', (body) => {
    expect(() => parseRemoteScreenCommand(body)).toThrow('Invalid remote screen command')
  })

  it('only accepts JPEG frames', () => {
    const base = { sessionId: 'a'.repeat(32), width: 720, height: 1600 }
    expect(parseRemoteScreenFrame({ ...base, image: JPEG }).image).toBe(JPEG)
    for (const image of [
      Buffer.from('<svg onload=alert(1)>').toString('base64'),
      'data:image/jpeg;base64,' + JPEG,
      JPEG + '<>',
    ])
      expect(() => parseRemoteScreenFrame({ ...base, image })).toThrow()
    expect(() =>
      parseRemoteScreenFrame({ ...base, sessionId: 'nope', image: JPEG }),
    ).toThrow()
    expect(parseRemoteScreenFrame({ sessionId: base.sessionId })).toEqual({
      sessionId: base.sessionId,
    })
    expect(() => parseRemoteScreenFrame({ ...base })).toThrow()
  })

  it('validates status reports', () => {
    expect(
      parseRemoteScreenStatus({ sessionId: 'b'.repeat(32), state: 'unsupported_android' })
        .state,
    ).toBe('unsupported_android')
    expect(() =>
      parseRemoteScreenStatus({ sessionId: 'b'.repeat(32), state: 'hacked' }),
    ).toThrow()
  })
})

describe('RemoteScreenController boundary', () => {
  it('requires authentication and device ownership on every route', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, RemoteScreenController)
    expect(guards).toEqual([AuthGuard, CanModifyDevice])
  })

  it('refuses API-key callers on viewer routes', async () => {
    const service = { start: jest.fn(), view: jest.fn(), queueCommand: jest.fn(), stop: jest.fn() }
    const controller = new RemoteScreenController(service as never)
    const apiKeyRequest = { apiKey: { _id: 'k' }, user: { _id: 'owner' } }
    await expect(controller.start(DEVICE, apiKeyRequest)).rejects.toThrow('dashboard login')
    await expect(controller.view(DEVICE, undefined, apiKeyRequest)).rejects.toThrow(
      'dashboard login',
    )
    await expect(
      controller.input(DEVICE, { type: 'tap', x: 0, y: 0 }, apiKeyRequest),
    ).rejects.toThrow('dashboard login')
    await expect(controller.stop(DEVICE, apiKeyRequest)).rejects.toThrow('dashboard login')
    expect(service.start).not.toHaveBeenCalled()
    expect(service.queueCommand).not.toHaveBeenCalled()
  })
})
