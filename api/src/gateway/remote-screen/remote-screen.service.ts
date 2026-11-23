import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import * as firebase from 'firebase-admin'
import { randomBytes } from 'crypto'
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

export interface RemoteScreenView {
  active: boolean
  sessionId: string | null
  startedAt: number | null
  status: RemoteScreenStatus | null
  frame: RemoteScreenFrame | null
}

@Injectable()
export class RemoteScreenService {
  private readonly logger = new Logger(RemoteScreenService.name)

  constructor(
    private readonly store: RemoteScreenStore,
    @InjectModel(Device.name) private readonly devices: Model<DeviceDocument>,
  ) {}

  /** Starts (or rejoins) a viewing session and wakes the phone over FCM. */
  async start(deviceId: string, viewerId: string) {
    const device = await this.devices
      .findById(deviceId)
      .select('_id fcmToken')
      .lean()
      .exec()
    if (!device?.fcmToken)
      throw new BadRequestException(
        'This device has no push token yet. Open the Gabay SMS app on the phone once, then try again.',
      )

    const existing = await this.store.getSession(deviceId)
    const session: RemoteScreenSession = existing ?? {
      sessionId: randomBytes(16).toString('hex'),
      startedAt: Date.now(),
      startedBy: viewerId,
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
    return { sessionId: session.sessionId, startedAt: session.startedAt }
  }

  async stop(deviceId: string) {
    const session = await this.store.getSession(deviceId)
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
   * Viewer poll. Keeps the session alive and returns the latest frame, unless
   * the viewer already has it (`sinceCapturedAt`).
   */
  async view(deviceId: string, sinceCapturedAt?: number): Promise<RemoteScreenView> {
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
   * Phone upload. The reply tells the phone whether anyone is still watching
   * and carries the taps queued since its last upload.
   */
  async acceptFrame(deviceId: string, input: RemoteScreenFrameInput) {
    const session = await this.store.getSession(deviceId)
    if (!session || session.sessionId !== input.sessionId)
      return { active: false, commands: [] as RemoteScreenCommand[] }

    const existing =
      input.image === undefined ? await this.store.getFrame(deviceId) : null
    await Promise.all([
      input.image !== undefined
        ? this.store.setFrame(
            deviceId,
            {
              sessionId: input.sessionId,
              width: input.width,
              height: input.height,
              image: input.image,
              capturedAt: Date.now(),
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
        data: { type: 'remote_screen', action, sessionId, targetDeviceId: deviceId },
        android: { priority: 'high', ttl: 60_000 },
      })
    } catch (error) {
      this.logger.warn(
        `Remote screen ${action} push failed for device ${deviceId}: ${
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
