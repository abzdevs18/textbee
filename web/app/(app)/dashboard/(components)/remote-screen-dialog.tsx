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
  | 'streaming'
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

const POLL_MS = 700
/** A frame older than this means the phone stopped uploading. */
const STALE_MS = 6000
const SWIPE_MIN_PX = 12

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
  const pointerStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      await httpBrowserClient.post(ApiEndpoints.gateway.remoteScreenSession(deviceId))
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
    void start()
    return () => {
      void httpBrowserClient
        .delete(ApiEndpoints.gateway.remoteScreenSession(deviceId))
        .catch(() => undefined)
    }
  }, [open, deviceId, start])

  // Poll frames while open.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await httpBrowserClient.get(
          ApiEndpoints.gateway.remoteScreen(deviceId, sinceRef.current),
        )
        const view: RemoteScreenView = res.data?.data
        if (cancelled) return
        setStatus(view?.status ?? null)
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
        }
        if (view && !view.active && view.status?.state === 'stopped') {
          setError(view.status.message ?? 'The session ended')
          return
        }
      } catch {
        // Transient; keep polling.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, deviceId])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
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

  const problem =
    state === 'accessibility_disabled'
      ? 'Remote screen is turned off on the phone. On the phone open Gabay SMS → Settings → Remote Screen and turn on “Gabay SMS remote screen”.'
      : state === 'unsupported_android'
        ? status?.message ?? 'This phone runs an Android version older than 11, which cannot share its screen this way.'
        : state === 'capture_failed'
          ? status?.message ?? 'The phone could not take screenshots.'
          : waitingTooLong
            ? 'The phone has not answered yet. It may be offline, or running an older app version without Remote Screen — update it to the latest Gabay SMS app.'
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
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={image}
              alt={`Screen of ${deviceName}`}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerLeave={() => (pointerStart.current = null)}
              className={`max-h-[65vh] w-auto cursor-pointer select-none touch-none ${stale ? 'opacity-60' : ''}`}
            />
          ) : (
            <div className='flex flex-col items-center gap-2 p-6 text-center text-xs text-white/70'>
              <Loader2 className='h-5 w-5 animate-spin' />
              {starting ? 'Waking the phone…' : 'Waiting for the phone’s screen…'}
            </div>
          )}
          {pendingInput && (
            <div className='absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white'>
              Sending…
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
          The phone shows a notification while it is being viewed. Viewing stops
          when you close this window, or after 30 minutes.
        </p>
      </DialogContent>
    </Dialog>
  )
}
