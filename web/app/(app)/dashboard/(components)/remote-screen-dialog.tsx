'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  Circle,
  Loader2,
  RefreshCw,
  Square,
  TriangleAlert,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import httpBrowserClient from '@/lib/httpBrowserClient'
import { ApiEndpoints } from '@/config/api'
import { formatError } from '@/lib/utils/errorHandler'

type DeviceState =
  | 'starting'
  | 'connecting'
  /** Android 10 and older: the phone is showing the screen-capture permission. */
  | 'awaiting_consent'
  | 'streaming'
  | 'upload_failed'
  | 'accessibility_disabled'
  | 'unsupported_android'
  | 'capture_failed'
  | 'stopped'

type RemoteScreenView = {
  active: boolean
  sessionId: string | null
  status: { state: DeviceState; message?: string; at: number } | null
  frame: {
    width: number
    height: number
    image: string
    capturedAt: number
  } | null
}

type Command =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'global'; action: 'back' | 'home' | 'recents' | 'notifications' }

/** Back-off after a failed poll; successful polls re-request immediately. */
const RETRY_MS = 1000
/** A frame older than this means the phone stopped uploading. */
const STALE_MS = 6000
const SWIPE_MIN_PX = 12
/** First Android build with Remote Screen (2.8.23). */
const MIN_APP_VERSION_CODE = 41
const RESTART_AFTER_MS = 5000

const clamp = (value: number) => Math.min(1, Math.max(0, value))

export default function RemoteScreenDialog({
  deviceId,
  deviceName,
  open,
  onOpenChange,
}: {
  deviceId: string
  deviceName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState<RemoteScreenView['status']>(null)
  const [image, setImage] = useState<string | null>(null)
  // Browser-clock times, so server/browser clock skew cannot matter.
  const [aliveAt, setAliveAt] = useState<number | null>(null)
  const [openedAt, setOpenedAt] = useState(Date.now())
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const sinceRef = useRef<number | undefined>(undefined)
  const lastStatusAt = useRef<number | undefined>(undefined)
  const lastSeenStatusAt = useRef<number | undefined>(undefined)
  const sessionIdRef = useRef<string | null>(null)
  const lastStartAt = useRef(0)
  const [appVersion, setAppVersion] = useState<{
    code: number | null
    name: string | null
  } | null>(null)
  const pointerStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const [taps, setTaps] = useState<{ id: number; x: number; y: number }[]>([])
  const frameTimes = useRef<number[]>([])
  const [fps, setFps] = useState(0)
  const imgRef = useRef<HTMLImageElement>(null)

  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    lastStartAt.current = Date.now()
    try {
      const res = await httpBrowserClient.post(
        ApiEndpoints.gateway.remoteScreenSession(deviceId),
      )
      const data = res.data?.data
      sessionIdRef.current = data?.sessionId ?? null
      setAppVersion({
        code: data?.appVersionCode ?? null,
        name: data?.appVersionName ?? null,
      })
    } catch (err) {
      setError(formatError(err).message)
    } finally {
      setStarting(false)
    }
  }, [deviceId])

  // Start on open, stop on close.
  useEffect(() => {
    if (!open) return
    sinceRef.current = undefined
    setImage(null)
    setStatus(null)
    setAliveAt(null)
    setOpenedAt(Date.now())
    lastStatusAt.current = undefined
    lastSeenStatusAt.current = undefined
    frameTimes.current = []
    void start()
    return () => {
      // Scoped to our own session so a late close can't end a newer one.
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (!sessionId) return
      void httpBrowserClient
        .delete(ApiEndpoints.gateway.remoteScreenSession(deviceId, sessionId))
        .catch(() => undefined)
    }
  }, [open, deviceId, start])

  // Poll frames while open.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      let delay = 0
      try {
        // Long-poll: answered as soon as the phone uploads a new frame.
        const res = await httpBrowserClient.get(
          ApiEndpoints.gateway.remoteScreen(
            deviceId,
            sinceRef.current,
            lastSeenStatusAt.current,
          ),
          { timeout: 20000 },
        )
        const view: RemoteScreenView = res.data?.data
        if (cancelled) return
        setStatus(view?.status ?? null)
        lastSeenStatusAt.current = view?.status?.at
        // Every phone upload (even "screen unchanged") refreshes status.at.
        if (
          view?.status?.state === 'streaming' &&
          view.status.at !== lastStatusAt.current
        ) {
          lastStatusAt.current = view.status.at
          setAliveAt(Date.now())
        }
        if (view?.frame?.image) {
          sinceRef.current = view.frame.capturedAt
          setImage(`data:image/jpeg;base64,${view.frame.image}`)
          const t = Date.now()
          frameTimes.current = [...frameTimes.current.filter((x) => t - x < 5000), t]
        }
        if (view && !view.active) delay = RETRY_MS
        if (view && !view.active && view.status?.state === 'stopped') {
          setError(view.status.message ?? 'The session ended')
          return
        }
        // Session vanished (expired, or ended by another tab): start a new one.
        if (
          view &&
          !view.active &&
          Date.now() - lastStartAt.current > RESTART_AFTER_MS
        ) {
          void start()
        }
      } catch {
        // Transient; keep polling.
        delay = RETRY_MS
      }
      if (!cancelled) timer = setTimeout(poll, delay)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, deviceId, start])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      setFps(frameTimes.current.filter((x) => t - x < 5000).length / 5)
    }, 1000)
    return () => clearInterval(id)
  }, [open])

  const send = useCallback(
    async (command: Command) => {
      setSentAt(Date.now())
      try {
        await httpBrowserClient.post(
          ApiEndpoints.gateway.remoteScreenInput(deviceId),
          command,
        )
      } catch (err) {
        setError(formatError(err).message)
      }
    },
    [deviceId],
  )

  const relative = (clientX: number, clientY: number) => {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return null
    return {
      x: clamp((clientX - rect.left) / rect.width),
      y: clamp((clientY - rect.top) / rect.height),
      px: clientX,
      py: clientY,
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    e.preventDefault()
    pointerStart.current = { x: e.clientX, y: e.clientY, t: Date.now() }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    const startPoint = pointerStart.current
    pointerStart.current = null
    if (!startPoint) return
    const a = relative(startPoint.x, startPoint.y)
    const b = relative(e.clientX, e.clientY)
    if (!a || !b) return
    const moved = Math.hypot(b.px - a.px, b.py - a.py)
    if (moved < SWIPE_MIN_PX) {
      // Instant local feedback; the phone's frame follows a moment later.
      const id = Date.now()
      setTaps((list) => [...list, { id, x: a.x, y: a.y }])
      setTimeout(() => setTaps((list) => list.filter((tap) => tap.id !== id)), 700)
      void send({ type: 'tap', x: a.x, y: a.y })
    } else {
      void send({
        type: 'swipe',
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        durationMs: Math.min(3000, Math.max(150, Date.now() - startPoint.t)),
      })
    }
  }

  const state = status?.state
  const stale = !aliveAt || now - aliveAt > STALE_MS
  const waitingTooLong =
    !image && (!state || state === 'starting') && now - openedAt > 20000
  const pendingInput = !!sentAt && now - sentAt < 1500

  const outdatedApp =
    appVersion?.code != null && appVersion.code < MIN_APP_VERSION_CODE

  const problem =
    state === 'awaiting_consent'
      ? 'The phone is asking for screen-capture permission. Someone at the phone must tap “Start now” once — tick “Don’t show again” first (Android 9 and older) so it never asks again.'
      : state === 'upload_failed'
      ? `The phone is capturing its screen but cannot upload it${status?.message ? ` (${status.message})` : ''}. Check its internet connection.`
      : state === 'accessibility_disabled'
      ? 'Remote screen is turned off on the phone. On the phone open Gabay SMS → Settings → Remote Screen and turn on “Gabay SMS remote screen”.'
      : state === 'unsupported_android'
        ? status?.message ?? 'This phone’s Android version cannot share its screen.'
        : state === 'capture_failed'
          ? status?.message ?? 'The phone could not take screenshots.'
          : waitingTooLong
            ? outdatedApp
              ? `This phone last reported app version ${appVersion?.name ?? appVersion?.code}. Remote Screen needs Gabay SMS 2.8.26 — install the update on the phone.`
              : 'The phone has not answered yet. It may be offline, asleep with background activity restricted, or not yet updated to Gabay SMS 2.8.26.'
            : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[95vh] overflow-y-auto sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            Live screen — {deviceName}
            {image && !stale ? (
              <Badge className='bg-emerald-600 text-xs hover:bg-emerald-600'>Live</Badge>
            ) : image && stale ? (
              <Badge variant='secondary' className='text-xs'>Paused</Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className='text-left'>
            Click on the screen to tap, drag to swipe. If Android asks whether
            Gabay SMS may send a large number of messages, tap{' '}
            <span className='font-medium text-foreground'>Allow</span> (tick
            “Remember my choice” / “Always allow” first when it is offered).
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className='flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300'>
            <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
            <span>{error}</span>
          </div>
        )}
        {problem && (
          <div className='flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'>
            <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
            <span>{problem}</span>
          </div>
        )}

        <div className='relative mx-auto flex min-h-[320px] w-full items-center justify-center overflow-hidden rounded-lg border bg-black'>
          {image ? (
            <div className='relative inline-block'>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={image}
                alt={`Screen of ${deviceName}`}
                draggable={false}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerLeave={() => (pointerStart.current = null)}
                className={`block max-h-[65vh] w-auto cursor-pointer select-none touch-none ${stale ? 'opacity-60' : ''}`}
              />
              {taps.map((tap) => (
                <span
                  key={tap.id}
                  className='pointer-events-none absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-emerald-400/70'
                  style={{ left: `${tap.x * 100}%`, top: `${tap.y * 100}%` }}
                />
              ))}
            </div>
          ) : (
            <div className='flex flex-col items-center gap-2 p-6 text-center text-xs text-white/70'>
              <Loader2 className='h-5 w-5 animate-spin' />
              {starting
                ? 'Waking the phone…'
                : state === 'connecting'
                  ? 'Phone received the request — capturing the screen…'
                  : state === 'awaiting_consent'
                    ? 'Waiting for screen-capture permission on the phone…'
                  : 'Waiting for the phone to answer…'}
            </div>
          )}
          {pendingInput && (
            <div className='absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white'>
              Sending…
            </div>
          )}
          {image && !stale && fps > 0 && (
            <div className='absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white'>
              {fps.toFixed(1)} fps
            </div>
          )}
        </div>

        <div className='flex flex-wrap items-center justify-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={!image}
            onClick={() => send({ type: 'global', action: 'back' })}
          >
            <ArrowLeft className='mr-1 h-4 w-4' /> Back
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={!image}
            onClick={() => send({ type: 'global', action: 'home' })}
          >
            <Circle className='mr-1 h-4 w-4' /> Home
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={!image}
            onClick={() => send({ type: 'global', action: 'recents' })}
          >
            <Square className='mr-1 h-4 w-4' /> Recents
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={!image}
            onClick={() => send({ type: 'global', action: 'notifications' })}
          >
            <Bell className='mr-1 h-4 w-4' /> Notifications
          </Button>
          <Button variant='ghost' size='sm' disabled={starting} onClick={() => void start()}>
            <RefreshCw className={`mr-1 h-4 w-4 ${starting ? 'animate-spin' : ''}`} />
            Wake again
          </Button>
        </div>
        <p className='text-center text-[11px] text-muted-foreground'>
          Viewing stops when you close this window, or after 30 minutes.
        </p>
      </DialogContent>
    </Dialog>
  )
}
