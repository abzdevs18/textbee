import { Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import {
  RemoteScreenCommand,
  RemoteScreenDeviceState,
} from './remote-screen.dto'

export interface RemoteScreenSession {
  sessionId: string
  startedAt: number
  startedBy: string
}

export interface RemoteScreenFrame {
  sessionId: string
  width: number
  height: number
  image: string
  capturedAt: number
}

export interface RemoteScreenStatus {
  sessionId: string
  state: RemoteScreenDeviceState
  message?: string
  at: number
}

/**
 * Short-lived remote-screen state. Nothing here is durable: sessions expire a
 * few seconds after the viewer stops polling, frames shortly after capture.
 */
export abstract class RemoteScreenStore {
  abstract getSession(deviceId: string): Promise<RemoteScreenSession | null>
  abstract setSession(
    deviceId: string,
    session: RemoteScreenSession,
    ttlMs: number,
  ): Promise<void>
  abstract clear(deviceId: string): Promise<void>
  abstract setFrame(
    deviceId: string,
    frame: RemoteScreenFrame,
    ttlMs: number,
  ): Promise<void>
  abstract getFrame(deviceId: string): Promise<RemoteScreenFrame | null>
  abstract setStatus(
    deviceId: string,
    status: RemoteScreenStatus,
    ttlMs: number,
  ): Promise<void>
  abstract getStatus(deviceId: string): Promise<RemoteScreenStatus | null>
  /** Returns false when the queue is full. */
  abstract pushCommand(
    deviceId: string,
    command: RemoteScreenCommand,
    maxQueued: number,
    ttlMs: number,
  ): Promise<boolean>
  abstract drainCommands(deviceId: string): Promise<RemoteScreenCommand[]>
}

const key = (deviceId: string, part: string) => `remote-screen:${deviceId}:${part}`

function parse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Shared across API instances so the phone and the viewer may hit different replicas. */
export class RedisRemoteScreenStore
  extends RemoteScreenStore
  implements OnModuleDestroy
{
  constructor(private readonly redis: Redis) {
    super()
  }

  async onModuleDestroy() {
    this.redis.disconnect()
  }

  async getSession(deviceId: string) {
    return parse<RemoteScreenSession>(
      await this.redis.get(key(deviceId, 'session')),
    )
  }

  async setSession(deviceId: string, session: RemoteScreenSession, ttlMs: number) {
    await this.redis.set(key(deviceId, 'session'), JSON.stringify(session), 'PX', ttlMs)
  }

  async clear(deviceId: string) {
    await this.redis.del(
      key(deviceId, 'session'),
      key(deviceId, 'frame'),
      key(deviceId, 'status'),
      key(deviceId, 'commands'),
    )
  }

  async setFrame(deviceId: string, frame: RemoteScreenFrame, ttlMs: number) {
    await this.redis.set(key(deviceId, 'frame'), JSON.stringify(frame), 'PX', ttlMs)
  }

  async getFrame(deviceId: string) {
    return parse<RemoteScreenFrame>(await this.redis.get(key(deviceId, 'frame')))
  }

  async setStatus(deviceId: string, status: RemoteScreenStatus, ttlMs: number) {
    await this.redis.set(key(deviceId, 'status'), JSON.stringify(status), 'PX', ttlMs)
  }

  async getStatus(deviceId: string) {
    return parse<RemoteScreenStatus>(await this.redis.get(key(deviceId, 'status')))
  }

  async pushCommand(
    deviceId: string,
    command: RemoteScreenCommand,
    maxQueued: number,
    ttlMs: number,
  ) {
    const k = key(deviceId, 'commands')
    if ((await this.redis.llen(k)) >= maxQueued) return false
    await this.redis
      .multi()
      .rpush(k, JSON.stringify(command))
      .pexpire(k, ttlMs)
      .exec()
    return true
  }

  async drainCommands(deviceId: string) {
    const k = key(deviceId, 'commands')
    const result = await this.redis.multi().lrange(k, 0, -1).del(k).exec()
    const raw = (result?.[0]?.[1] as string[] | undefined) ?? []
    return raw
      .map((item) => parse<RemoteScreenCommand>(item))
      .filter((item): item is RemoteScreenCommand => !!item)
  }
}

/** Single-instance fallback (local dev / no REDIS_URL). */
export class MemoryRemoteScreenStore extends RemoteScreenStore {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>()

  private read<T>(k: string): T | null {
    const entry = this.entries.get(k)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(k)
      return null
    }
    return entry.value as T
  }

  private write(k: string, value: unknown, ttlMs: number) {
    this.entries.set(k, { value, expiresAt: Date.now() + ttlMs })
  }

  async getSession(deviceId: string) {
    return this.read<RemoteScreenSession>(key(deviceId, 'session'))
  }

  async setSession(deviceId: string, session: RemoteScreenSession, ttlMs: number) {
    this.write(key(deviceId, 'session'), session, ttlMs)
  }

  async clear(deviceId: string) {
    for (const part of ['session', 'frame', 'status', 'commands'])
      this.entries.delete(key(deviceId, part))
  }

  async setFrame(deviceId: string, frame: RemoteScreenFrame, ttlMs: number) {
    this.write(key(deviceId, 'frame'), frame, ttlMs)
  }

  async getFrame(deviceId: string) {
    return this.read<RemoteScreenFrame>(key(deviceId, 'frame'))
  }

  async setStatus(deviceId: string, status: RemoteScreenStatus, ttlMs: number) {
    this.write(key(deviceId, 'status'), status, ttlMs)
  }

  async getStatus(deviceId: string) {
    return this.read<RemoteScreenStatus>(key(deviceId, 'status'))
  }

  async pushCommand(
    deviceId: string,
    command: RemoteScreenCommand,
    maxQueued: number,
    ttlMs: number,
  ) {
    const k = key(deviceId, 'commands')
    const queue = this.read<RemoteScreenCommand[]>(k) ?? []
    if (queue.length >= maxQueued) return false
    this.write(k, [...queue, command], ttlMs)
    return true
  }

  async drainCommands(deviceId: string) {
    const k = key(deviceId, 'commands')
    const queue = this.read<RemoteScreenCommand[]>(k) ?? []
    this.entries.delete(k)
    return queue
  }
}

export function createRemoteScreenStore(redisUrl?: string): RemoteScreenStore {
  const logger = new Logger('RemoteScreenStore')
  if (!redisUrl) {
    logger.warn(
      'REDIS_URL is not set; remote screen state is in-memory and only works with a single API instance.',
    )
    return new MemoryRemoteScreenStore()
  }
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  })
  redis.on('error', (error) =>
    logger.warn(`Redis error: ${error?.message ?? error}`),
  )
  return new RedisRemoteScreenStore(redis)
}
