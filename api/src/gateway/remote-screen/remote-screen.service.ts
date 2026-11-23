import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import * as firebase from 'firebase-admin'
import { randomBytes, timingSafeEqual } from 'crypto'
import { Device, DeviceDocument } from '../schemas/device.schema'
import {
  RemoteScreenCommand,
  RemoteScreenFrameInput,
  RemoteScreenStatusInput,
} from './remote-screen.dto'
import {
  RemoteScreenFrame,
  RemoteScreenSession,
  RemoteScreenStatus,
  RemoteScreenStore,
} from './remote-screen.store'

/** A session dies this long after the viewer's last poll (closed tab, lost network). */
export const REMOTE_SCREEN_SESSION_TTL_MS = 30_000
/** Hard cap so a forgotten tab can't keep a phone streaming forever. */
export const REMOTE_SCREEN_MAX_SESSION_MS = 30 * 60_000
export const REMOTE_SCREEN_FRAME_TTL_MS = 15_000
export const REMOTE_SCREEN_STATUS_TTL_MS = 60_000
export const REMOTE_SCREEN_COMMAND_TTL_MS = 15_000
export const REMOTE_SCREEN_MAX_QUEUED_COMMANDS = 20
/** Long-poll: hold a request open this long waiting for something new. */
export const REMOTE_SCREEN_MAX_WAIT_MS = 8_000
const LONG_POLL_STEP_MS = 100
const STREAM_STEP_MS = 40

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface RemoteScreenView {
  active: boolean
  sessionId: string | null
  startedAt: number | null
  status: RemoteScreenStatus | null
  frame: RemoteScreenFrame | null
}

@Injectable()
export class RemoteScreenService {
  protected readonly logger = new Logger(RemoteScreenService.name)
  /** FCM data `type` the phone dispatches on. */
  protected readonly pushType: string = 'remote_screen'

  constructor(
    protected readonly store: RemoteScreenStore,
    @InjectModel(Device.name) protected readonly devices: Model<DeviceDocument>,
  ) {}

  /** Starts (or rejoins) a viewing session and wakes the phone over FCM. */
  async start(deviceId: string, viewerId: string) {
    const device = await this.devices
      .findById(deviceId)
      .select('_id fcmToken appVersionInfo')
      .lean()
      .exec()
    if (!device?.fcmToken)
      throw new BadRequestException(
        'This device has no push token yet. Open the Gabay SMS app on the phone once, then try again.',
      )

    const existing = await this.store.getSession(deviceId)
    const session: RemoteScreenSession = existing
      ? { ...existing, streamToken: existing.streamToken ?? randomBytes(24).toString('hex') }
      : {
          sessionId: randomBytes(16).toString('hex'),
          startedAt: Date.now(),
          startedBy: viewerId,
          streamToken: randomBytes(24).toString('hex'),
        }
    await this.store.setSession(deviceId, session, REMOTE_SCREEN_SESSION_TTL_MS)
    if (!existing) {
      await this.store.setStatus(
        deviceId,
        { sessionId: session.sessionId, state: 'starting', at: Date.now() },
        REMOTE_SCREEN_STATUS_TTL_MS,
      )
    }

    // Always re-push: the phone may have missed the first one, or the viewer
    // pressed "Retry" because nothing arrived.
    await this.push(device.fcmToken, deviceId, 'start', session.sessionId)
    return {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      streamToken: session.streamToken,
      // Last version the phone reported in its heartbeat, so the viewer can
      // tell "old app" apart from "phone offline".
      appVersionCode: device.appVersionInfo?.versionCode ?? null,
      appVersionName: device.appVersionInfo?.versionName ?? null,
    }
  }

  /**
   * Ends the session. With `sessionId`, only that session is ended: a viewer
   * that closes late must not end a newer viewer's session.
   */
  async stop(deviceId: string, sessionId?: string) {
    const session = await this.store.getSession(deviceId)
    if (session && sessionId && session.sessionId !== sessionId)
      return { stopped: false }
    await this.store.clear(deviceId)
    if (!session) return { stopped: true }
    const device = await this.devices
      .findById(deviceId)
      .select('fcmToken')
      .lean()
      .exec()
    if (device?.fcmToken) {
      // Best effort: the phone also stops on its own at its next upload,
      // because the session is gone.
      await this.push(device.fcmToken, deviceId, 'stop', session.sessionId).catch(
        () => undefined,
      )
    }
    return { stopped: true }
  }

  /**
   * Viewer poll. With `waitMs`, holds the request until there is a frame newer
   * than `sinceCapturedAt` or a status newer than `sinceStatusAt` (or the wait
   * runs out), so frames reach the viewer as soon as the phone uploads them.
   */
  async view(
    deviceId: string,
    sinceCapturedAt?: number,
    sinceStatusAt?: number,
    waitMs = 0,
  ): Promise<RemoteScreenView> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), REMOTE_SCREEN_MAX_WAIT_MS)
    for (;;) {
      const result = await this.viewOnce(deviceId, sinceCapturedAt)
      if (!result.active || Date.now() >= deadline) return result
      if (result.frame?.image) return result
      if (result.status && result.status.at !== sinceStatusAt) return result
      await sleep(LONG_POLL_STEP_MS)
    }
  }

  private async viewOnce(
    deviceId: string,
    sinceCapturedAt?: number,
  ): Promise<RemoteScreenView> {
    const session = await this.store.getSession(deviceId)
    if (!session)
      return { active: false, sessionId: null, startedAt: null, status: null, frame: null }

    if (Date.now() - session.startedAt > REMOTE_SCREEN_MAX_SESSION_MS) {
      await this.stop(deviceId)
      return {
        active: false,
        sessionId: null,
        startedAt: null,
        status: {
          sessionId: session.sessionId,
          state: 'stopped',
          message: 'Session reached the 30-minute limit',
          at: Date.now(),
        },
        frame: null,
      }
    }

    await this.store.setSession(deviceId, session, REMOTE_SCREEN_SESSION_TTL_MS)
    const [status, frame] = await Promise.all([
      this.store.getStatus(deviceId),
      this.store.getFrame(deviceId),
    ])
    const current = frame?.sessionId === session.sessionId ? frame : null
    const fresh =
      current && (!sinceCapturedAt || current.capturedAt > sinceCapturedAt)
    return {
      active: true,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      status: status?.sessionId === session.sessionId ? status : null,
      frame: fresh
        ? current
        : current
          ? { ...current, image: '' } // unchanged: metadata only
          : null,
    }
  }

  async queueCommand(deviceId: string, command: RemoteScreenCommand) {
    const session = await this.store.getSession(deviceId)
    if (!session)
      throw new ConflictException('No active remote screen session for this device')
    const queued = await this.store.pushCommand(
      deviceId,
      command,
      REMOTE_SCREEN_MAX_QUEUED_COMMANDS,
      REMOTE_SCREEN_COMMAND_TTL_MS,
    )
    if (!queued)
      throw new HttpException(
        'The phone has not picked up earlier taps yet; wait a moment',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    return { queued: true }
  }

  /**
   * Phone: wait (long-poll) for viewer input, so a tap reaches the phone
   * immediately instead of riding on the next frame upload.
   */
  async pollCommands(deviceId: string, sessionId: string, waitMs = 0) {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), REMOTE_SCREEN_MAX_WAIT_MS)
    for (;;) {
      const session = await this.store.getSession(deviceId)
      if (!session || session.sessionId !== sessionId)
        return { active: false, commands: [] as RemoteScreenCommand[] }
      const commands = await this.store.drainCommands(deviceId)
      if (commands.length || Date.now() >= deadline)
        return { active: true, commands }
      await sleep(LONG_POLL_STEP_MS)
    }
  }

  /**
   * Phone upload. The reply tells the phone whether anyone is still watching
   * and carries the taps queued since its last upload.
   */
  async acceptFrame(deviceId: string, input: RemoteScreenFrameInput) {
    const session = await this.store.getSession(deviceId)
    if (!session || session.sessionId !== input.sessionId)
      return { active: false, commands: [] as RemoteScreenCommand[] }

    const existing = await this.store.getFrame(deviceId)
    // Parallel uploads can land out of order: never replace a newer frame.
    const stale =
      input.seq !== undefined &&
      existing?.sessionId === input.sessionId &&
      existing.seq !== undefined &&
      existing.seq >= input.seq
    await Promise.all([
      stale
        ? Promise.resolve()
        : input.image !== undefined
        ? this.store.setFrame(
            deviceId,
            {
              sessionId: input.sessionId,
              width: input.width,
              height: input.height,
              image: input.image,
              capturedAt: Date.now(),
              ...(input.seq !== undefined ? { seq: input.seq } : {}),
            },
            REMOTE_SCREEN_FRAME_TTL_MS,
          )
        : existing?.sessionId === input.sessionId
          ? // Unchanged screen: keep the last frame alive, same capturedAt so
            // viewers don't re-download it.
            this.store.setFrame(deviceId, existing, REMOTE_SCREEN_FRAME_TTL_MS)
          : Promise.resolve(),
      this.store.setStatus(
        deviceId,
        { sessionId: input.sessionId, state: 'streaming', at: Date.now() },
        REMOTE_SCREEN_STATUS_TTL_MS,
      ),
    ])
    const commands = await this.store.drainCommands(deviceId)
    return { active: true, commands }
  }

  /**
   * Viewer MJPEG stream: calls `onFrame` with each new JPEG until the session
   * ends, the viewer goes away (`isClosed`) or the session cap is hit.
   * Authenticated by the session's stream token instead of a login header,
   * because an <img> tag cannot send one.
   */
  async streamFrames(
    deviceId: string,
    streamToken: string,
    onFrame: (jpeg: Buffer) => Promise<void> | void,
    isClosed: () => boolean,
  ) {
    const session = await this.store.getSession(deviceId)
    if (
      !session?.streamToken ||
      typeof streamToken !== 'string' ||
      streamToken.length !== session.streamToken.length ||
      !timingSafeEqual(Buffer.from(streamToken), Buffer.from(session.streamToken))
    )
      throw new ForbiddenException('Invalid or expired stream')

    let lastCapturedAt = 0
    let lastRefresh = 0
    while (!isClosed()) {
      const current = await this.store.getSession(deviceId)
      if (!current || current.sessionId !== session.sessionId) return
      if (Date.now() - current.startedAt > REMOTE_SCREEN_MAX_SESSION_MS) return
      if (Date.now() - lastRefresh > 5_000) {
        // Watching the stream keeps the session alive like a poll does.
        await this.store.setSession(deviceId, current, REMOTE_SCREEN_SESSION_TTL_MS)
        lastRefresh = Date.now()
      }
      const frame = await this.store.getFrame(deviceId)
      if (
        frame?.sessionId === session.sessionId &&
        frame.image &&
        frame.capturedAt > lastCapturedAt
      ) {
        lastCapturedAt = frame.capturedAt
        await onFrame(Buffer.from(frame.image, 'base64'))
      } else {
        await sleep(STREAM_STEP_MS)
      }
    }
  }

  /** Phone reports why it cannot stream (accessibility off, Android too old...). */
  async acceptStatus(deviceId: string, input: RemoteScreenStatusInput) {
    const session = await this.store.getSession(deviceId)
    if (!session || session.sessionId !== input.sessionId) return { active: false }
    await this.store.setStatus(
      deviceId,
      { ...input, at: Date.now() },
      REMOTE_SCREEN_STATUS_TTL_MS,
    )
    return { active: input.state !== 'stopped' }
  }

  private async push(
    token: string,
    deviceId: string,
    action: 'start' | 'stop',
    sessionId: string,
  ) {
    try {
      await firebase.messaging().send({
        token,
        data: { type: this.pushType, action, sessionId, targetDeviceId: deviceId },
        android: { priority: 'high', ttl: 60_000 },
      })
    } catch (error) {
      this.logger.warn(
        `${this.pushType} ${action} push failed for device ${deviceId}: ${
          (error as { code?: string })?.code ?? 'unknown'
        }`,
      )
      if (action === 'start')
        throw new ServiceUnavailableException(
          'Could not reach the phone over push. Check that it is online and try again.',
        )
    }
  }
}
