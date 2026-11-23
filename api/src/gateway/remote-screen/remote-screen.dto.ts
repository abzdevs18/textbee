import { BadRequestException } from '@nestjs/common'

/**
 * Remote screen ("view the gateway phone's screen") wire types.
 *
 * The legacy app has no global validation pipe, so every body on these routes
 * is parsed by hand here and anything unexpected is rejected.
 */

export const REMOTE_SCREEN_GLOBAL_ACTIONS = [
  'back',
  'home',
  'recents',
  'notifications',
] as const
export type RemoteScreenGlobalAction =
  (typeof REMOTE_SCREEN_GLOBAL_ACTIONS)[number]

/** Coordinates are normalised to 0..1 of the frame, so the viewer never needs the phone's resolution. */
export type RemoteScreenCommand =
  | { type: 'tap'; x: number; y: number }
  | {
      type: 'swipe'
      x1: number
      y1: number
      x2: number
      y2: number
      durationMs: number
    }
  | { type: 'global'; action: RemoteScreenGlobalAction }

export type RemoteScreenDeviceState =
  | 'starting'
  /** Phone received the push and is starting capture. */
  | 'connecting'
  | 'streaming'
  /** Phone captures but its uploads are being rejected / failing. */
  | 'upload_failed'
  | 'accessibility_disabled'
  | 'unsupported_android'
  | 'capture_failed'
  | 'stopped'

export const REMOTE_SCREEN_DEVICE_STATES: RemoteScreenDeviceState[] = [
  'starting',
  'connecting',
  'streaming',
  'upload_failed',
  'accessibility_disabled',
  'unsupported_android',
  'capture_failed',
  'stopped',
]

/**
 * A frame upload. `image` is omitted when the screen has not changed since the
 * phone's previous upload; the call then only keeps the session alive and
 * collects queued input.
 */
export interface RemoteScreenFrameInput {
  sessionId: string
  /** All three are present together, or all omitted. */
  width?: number
  height?: number
  /** Base64 JPEG (no data: prefix). */
  image?: string
}

export interface RemoteScreenStatusInput {
  sessionId: string
  state: RemoteScreenDeviceState
  message?: string
}

/** ~1.5 MB of base64 is far above a 720p JPEG at q60; anything bigger is not a frame. */
export const MAX_FRAME_BASE64_LENGTH = 1_500_000
const SESSION_ID = /^[a-f0-9]{32}$/

function plainObject(body: unknown, error: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException(error)
  const proto = Object.getPrototypeOf(body)
  if (proto !== Object.prototype && proto !== null)
    throw new BadRequestException(error)
  return body as Record<string, unknown>
}

function onlyFields(
  body: Record<string, unknown>,
  allowed: string[],
  error: string,
) {
  const set = new Set(allowed)
  if (Object.keys(body).some((key) => !set.has(key)))
    throw new BadRequestException(error)
}

function unit(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new BadRequestException(error)
  if (value < 0 || value > 1) throw new BadRequestException(error)
  return value
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function parseRemoteScreenCommand(body: unknown): RemoteScreenCommand {
  const error = 'Invalid remote screen command'
  const input = plainObject(body, error)
  switch (input.type) {
    case 'tap':
      onlyFields(input, ['type', 'x', 'y'], error)
      return { type: 'tap', x: unit(input.x, error), y: unit(input.y, error) }
    case 'swipe': {
      onlyFields(input, ['type', 'x1', 'y1', 'x2', 'y2', 'durationMs'], error)
      const durationMs = input.durationMs ?? 300
      if (
        typeof durationMs !== 'number' ||
        !Number.isInteger(durationMs) ||
        durationMs < 50 ||
        durationMs > 3000
      )
        throw new BadRequestException(error)
      return {
        type: 'swipe',
        x1: unit(input.x1, error),
        y1: unit(input.y1, error),
        x2: unit(input.x2, error),
        y2: unit(input.y2, error),
        durationMs,
      }
    }
    case 'global':
      onlyFields(input, ['type', 'action'], error)
      if (
        !REMOTE_SCREEN_GLOBAL_ACTIONS.includes(
          input.action as RemoteScreenGlobalAction,
        )
      )
        throw new BadRequestException(error)
      return { type: 'global', action: input.action as RemoteScreenGlobalAction }
    default:
      throw new BadRequestException(error)
  }
}

export function parseRemoteScreenFrame(body: unknown): RemoteScreenFrameInput {
  const error = 'Invalid remote screen frame'
  const input = plainObject(body, error)
  onlyFields(input, ['sessionId', 'width', 'height', 'image'], error)
  if (!isSessionId(input.sessionId)) throw new BadRequestException(error)
  if (input.image === undefined) {
    if (input.width !== undefined || input.height !== undefined)
      throw new BadRequestException(error)
    return { sessionId: input.sessionId }
  }
  for (const size of [input.width, input.height]) {
    if (
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 16 ||
      size > 4096
    )
      throw new BadRequestException(error)
  }
  const image = input.image
  if (
    typeof image !== 'string' ||
    image.length < 16 ||
    image.length > MAX_FRAME_BASE64_LENGTH ||
    // Base64 of the JPEG SOI marker (FF D8 FF). Reject anything else so the
    // viewer can never be handed HTML/SVG through an <img> data URL.
    !image.startsWith('/9j/') ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image)
  )
    throw new BadRequestException(error)
  return {
    sessionId: input.sessionId,
    width: input.width as number,
    height: input.height as number,
    image,
  }
}

export function parseRemoteScreenStatus(
  body: unknown,
): RemoteScreenStatusInput {
  const error = 'Invalid remote screen status'
  const input = plainObject(body, error)
  onlyFields(input, ['sessionId', 'state', 'message'], error)
  if (!isSessionId(input.sessionId)) throw new BadRequestException(error)
  if (
    !REMOTE_SCREEN_DEVICE_STATES.includes(
      input.state as RemoteScreenDeviceState,
    )
  )
    throw new BadRequestException(error)
  let message: string | undefined
  if (input.message !== undefined) {
    if (typeof input.message !== 'string') throw new BadRequestException(error)
    message = input.message.slice(0, 200)
  }
  return {
    sessionId: input.sessionId,
    state: input.state as RemoteScreenDeviceState,
    ...(message ? { message } : {}),
  }
}
