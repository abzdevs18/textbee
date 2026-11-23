import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { AuthGuard } from '../../auth/guards/auth.guard'
import { CanModifyDevice } from '../guards/can-modify-device.guard'
import {
  RemoteCameraController,
  RemoteCameraStreamController,
} from './remote-camera.controller'
import { RemoteCameraService } from './remote-camera.service'
import { parseRemoteCameraCommand, parseRemoteScreenCommand, parseRemoteScreenFrame } from './remote-screen.dto'
import { MemoryRemoteScreenStore } from './remote-screen.store'

jest.mock('firebase-admin', () => {
  const send = jest.fn().mockResolvedValue('message-id')
  return { messaging: () => ({ send }), __send: send }
})
// eslint-disable-next-line @typescript-eslint/no-var-requires
const send = (require('firebase-admin') as { __send: jest.Mock }).__send

const DEVICE = '64b7f0c2a1b2c3d4e5f60718'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64')
const JPEG2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 2]).toString('base64')

function devicesModel(device: unknown) {
  const exec = jest.fn().mockResolvedValue(device)
  const chain = { select: () => chain, lean: () => chain, exec }
  return { findById: jest.fn(() => chain) }
}

describe('RemoteCameraService', () => {
  let service: RemoteCameraService
  beforeEach(() => {
    send.mockClear()
    service = new RemoteCameraService(
      new MemoryRemoteScreenStore('remote-camera'),
      devicesModel({ _id: DEVICE, fcmToken: 'token-1' }) as never,
    )
  })

  it('wakes the phone with the camera push type and hands out a stream token', async () => {
    const started = await service.start(DEVICE, 'owner')
    expect(started.streamToken).toMatch(/^[a-f0-9]{48}$/)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'remote_camera', action: 'start' }),
      }),
    )
  })

  it('ignores a late, older frame from parallel uploads', async () => {
    const { sessionId } = await service.start(DEVICE, 'owner')
    await service.acceptFrame(DEVICE, { sessionId, width: 640, height: 480, image: JPEG2, seq: 2 })
    await service.acceptFrame(DEVICE, { sessionId, width: 640, height: 480, image: JPEG, seq: 1 })
    expect((await service.view(DEVICE)).frame?.image).toBe(JPEG2)
  })

  it('streams new frames to the token holder and stops with the session', async () => {
    const { sessionId, streamToken } = await service.start(DEVICE, 'owner')
    const got: string[] = []
    let closed = false
    const streaming = service.streamFrames(
      DEVICE,
      streamToken!,
      (jpeg) => {
        got.push(jpeg.toString('base64'))
      },
      () => closed,
    )
    await service.acceptFrame(DEVICE, { sessionId, width: 640, height: 480, image: JPEG, seq: 1 })
    await new Promise((r) => setTimeout(r, 120))
    await service.acceptFrame(DEVICE, { sessionId, width: 640, height: 480, image: JPEG2, seq: 2 })
    await new Promise((r) => setTimeout(r, 120))
    await service.stop(DEVICE)
    await streaming
    closed = true
    expect(got).toEqual([JPEG, JPEG2])
  })

  it('rejects a wrong stream token', async () => {
    await service.start(DEVICE, 'owner')
    await expect(
      service.streamFrames(DEVICE, 'x'.repeat(48), () => undefined, () => false),
    ).rejects.toThrow('Invalid or expired stream')
  })
})

describe('Camera input and frames', () => {
  it('accepts only camera commands on the camera route', () => {
    expect(parseRemoteCameraCommand({ type: 'camera', action: 'switch' })).toEqual({
      type: 'camera',
      action: 'switch',
    })
    expect(() => parseRemoteCameraCommand({ type: 'tap', x: 0, y: 0 })).toThrow()
    expect(() => parseRemoteCameraCommand({ type: 'camera', action: 'record' })).toThrow()
    // ...and the screen route never takes camera commands.
    expect(() => parseRemoteScreenCommand({ type: 'camera', action: 'switch' })).toThrow()
  })

  it('validates frame sequence numbers', () => {
    const base = { sessionId: 'a'.repeat(32), width: 640, height: 480, image: JPEG }
    expect(parseRemoteScreenFrame({ ...base, seq: 5 }).seq).toBe(5)
    expect(() => parseRemoteScreenFrame({ ...base, seq: -1 })).toThrow()
    expect(() => parseRemoteScreenFrame({ ...base, seq: 1.5 })).toThrow()
  })

  it('guards viewer routes with login + ownership, and the stream with its token only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RemoteCameraController)).toEqual([
      AuthGuard,
      CanModifyDevice,
    ])
    expect(Reflect.getMetadata(GUARDS_METADATA, RemoteCameraStreamController)).toBeUndefined()
  })
})

describe('RemoteCameraStreamController', () => {
  it('writes a multipart MJPEG stream and ends when the session stops', async () => {
    const service = new RemoteCameraService(
      new MemoryRemoteScreenStore('remote-camera'),
      devicesModel({ _id: DEVICE, fcmToken: 'token-1' }) as never,
    )
    const { sessionId, streamToken } = await service.start(DEVICE, 'owner')
    const controller = new RemoteCameraStreamController(service)
    const chunks: Buffer[] = []
    const headers: Record<string, string> = {}
    let ended = false
    const res = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      status(code: number) { this.statusCode = code; return this },
      setHeader(k: string, v: string) { headers[k] = v },
      flushHeaders() { this.headersSent = true },
      write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true },
      once() { return this },
      on() { return this },
      end() { ended = true; this.writableEnded = true },
    }
    const req = { on: () => undefined }
    const streaming = controller.stream(DEVICE, streamToken!, req as never, res as never)
    await service.acceptFrame(DEVICE, { sessionId, width: 640, height: 480, image: JPEG, seq: 1 })
    await new Promise((r) => setTimeout(r, 150))
    await service.stop(DEVICE)
    await streaming
    const body = Buffer.concat(chunks)
    expect(res.statusCode).toBe(200)
    expect(headers['Content-Type']).toBe('multipart/x-mixed-replace; boundary=gabayframe')
    expect(headers['X-Accel-Buffering']).toBe('no')
    const jpeg = Buffer.from(JPEG, 'base64')
    expect(body.toString('latin1')).toBe(
      `--gabayframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n` +
        jpeg.toString('latin1') +
        '\r\n',
    )
    expect(ended).toBe(true)
  })

  it('refuses a bad token before sending anything', async () => {
    const service = new RemoteCameraService(
      new MemoryRemoteScreenStore('remote-camera'),
      devicesModel({ _id: DEVICE, fcmToken: 'token-1' }) as never,
    )
    await service.start(DEVICE, 'owner')
    const controller = new RemoteCameraStreamController(service)
    const res = { headersSent: false, writableEnded: false, on: () => undefined }
    await expect(
      controller.stream(DEVICE, 'nope', { on: () => undefined } as never, res as never),
    ).rejects.toThrow('Invalid or expired stream')
  })
})

describe('RemoteCameraStreamController over real HTTP', () => {
  it('delivers frames and notices when the viewer disconnects', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http')
    const service = new RemoteCameraService(
      new MemoryRemoteScreenStore('remote-camera'),
      devicesModel({ _id: DEVICE, fcmToken: 'token-1' }) as never,
    )
    const { sessionId, streamToken } = await service.start(DEVICE, 'owner')
    const controller = new RemoteCameraStreamController(service)
    let finished = false
    const app = express()
    app.get('/s', (req, res) => {
      void controller.stream(DEVICE, streamToken!, req, res).then(() => (finished = true))
    })
    const server = app.listen(0)
    const port = server.address().port
    await service.acceptFrame(DEVICE, { sessionId, width: 640, height: 480, image: JPEG, seq: 1 })
    const first = await new Promise<string>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}/s`, (response) => {
        expect(response.headers['content-type']).toContain('multipart/x-mixed-replace')
        response.once('data', (chunk: Buffer) => {
          resolve(chunk.toString('latin1'))
          request.destroy() // viewer closes the tab
        })
      })
      request.on('error', () => undefined)
      setTimeout(() => reject(new Error('no data')), 3000)
    })
    expect(first.startsWith('--gabayframe\r\nContent-Type: image/jpeg')).toBe(true)
    for (let i = 0; i < 30 && !finished; i++) await new Promise((r) => setTimeout(r, 50))
    expect(finished).toBe(true)
    // The session itself is untouched; only this viewer left.
    expect((await service.view(DEVICE)).active).toBe(true)
    server.close()
  })
})
