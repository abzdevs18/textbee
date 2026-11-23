'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Loader2,
  RefreshCw,
  RotateCw,
  SwitchCamera,
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

type CameraState =
  | 'starting'
  | 'connecting'
  | 'streaming'
  | 'upload_failed'
  | 'camera_off'
  | 'capture_failed'
  | 'stopped'

type CameraView = {
  active: boolean
  status: { state: CameraState; message?: string; at: number } | null
  frame: { image: string; capturedAt: number } | null
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || ''
const STATUS_POLL_MS = 2000
/** No picture this long while the phone says it's streaming → stream blocked; poll instead. */
const STREAM_FALLBACK_MS = 8000
/** Back-to-back long-polls in fallback mode. */
const RETRY_MS = 1000

export default function CameraDialog({
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
  const [status, setStatus] = useState<CameraView['status']>(null)
  const [streamToken, setStreamToken] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [streamShowing, setStreamShowing] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [pollImage, setPollImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const streamingSince = useRef<number | null>(null)

  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const res = await httpBrowserClient.post(
        ApiEndpoints.gateway.remoteCameraSession(deviceId),
      )
      const data = res.data?.data
      sessionIdRef.current = data?.sessionId ?? null
      setStreamToken(data?.streamToken ?? null)
      setAttempt((n) => n + 1)
    } catch (err) {
      setError(formatError(err).message)
    } finally {
      setStarting(false)
    }
  }, [deviceId])

  // Start on open, stop (our own session only) on close.
  useEffect(() => {
    if (!open) return
    setStatus(null)
    setStreamShowing(false)
    setFallback(false)
    setPollImage(null)
    streamingSince.current = null
    void start()
    return () => {
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      setStreamToken(null)
      if (!sessionId) return
      void httpBrowserClient
        .delete(ApiEndpoints.gateway.remoteCameraSession(deviceId, sessionId))
        .catch(() => undefined)
    }
  }, [open, deviceId, start])

  // Status: cheap poll without images (the picture comes from the stream).
  useEffect(() => {
    if (!open || fallback) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await httpBrowserClient.get(
          ApiEndpoints.gateway.remoteCamera(deviceId, {
            since: Number.MAX_SAFE_INTEGER,
          }),
        )
        const view: CameraView = res.data?.data
        if (cancelled) return
        setStatus(view?.status ?? null)
        if (view?.status?.state === 'streaming') {
          streamingSince.current ??= Date.now()
        } else {
          streamingSince.current = null
        }
        if (view && !view.active) {
          if (view.status?.state === 'stopped') {
            setError(view.status.message ?? 'The session ended')
            return
          }
          void start()
        }
      } catch {
        // transient
      }
      if (!cancelled) timer = setTimeout(poll, STATUS_POLL_MS)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, deviceId, fallback, start])

  // Stream blocked somewhere (proxy buffering)? Fall back to long-polling frames.
  useEffect(() => {
    if (!open || fallback || streamShowing) return
    const id = setInterval(() => {
      if (
        streamingSince.current &&
        Date.now() - streamingSince.current > STREAM_FALLBACK_MS
      )
        setFallback(true)
    }, 1000)
    return () => clearInterval(id)
  }, [open, fallback, streamShowing])

  useEffect(() => {
    if (!open || !fallback) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let since: number | undefined
    let statusAt: number | undefined
    const poll = async () => {
      let delay = 0
      try {
        const res = await httpBrowserClient.get(
          ApiEndpoints.gateway.remoteCamera(deviceId, { since, statusAt, wait: true }),
          { timeout: 20000 },
        )
        const view: CameraView = res.data?.data
        if (cancelled) return
        setStatus(view?.status ?? null)
        statusAt = view?.status?.at
        if (view?.frame?.image) {
          since = view.frame.capturedAt
          setPollImage(`data:image/jpeg;base64,${view.frame.image}`)
        }
        if (view && !view.active) {
          delay = RETRY_MS
          if (view.status?.state !== 'stopped') void start()
        }
      } catch {
        delay = RETRY_MS
      }
      if (!cancelled) timer = setTimeout(poll, delay)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, fallback, deviceId, start])

  const command = async (action: 'switch' | 'rotate') => {
    setBusy(true)
    try {
      await httpBrowserClient.post(ApiEndpoints.gateway.remoteCameraInput(deviceId), {
        type: 'camera',
        action,
      })
    } catch (err) {
      setError(formatError(err).message)
    } finally {
      setTimeout(() => setBusy(false), 800)
    }
  }

  const state = status?.state
  const live = state === 'streaming' && (streamShowing || !!pollImage)
  const problem =
    state === 'camera_off' || state === 'capture_failed' || state === 'upload_failed'
      ? status?.message ??
        (state === 'camera_off'
          ? 'Security camera is off on this phone. Turn it on in Gabay SMS → Settings → Security Camera.'
          : state === 'upload_failed'
            ? 'The phone cannot upload the camera picture. Check its internet connection.'
            : 'The camera could not start.')
      : null

  const streamUrl =
    streamToken && !fallback
      ? `${API_BASE}${ApiEndpoints.gateway.remoteCameraStream(deviceId, streamToken, attempt)}`
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[95vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            Camera — {deviceName}
            {live ? (
              <Badge className='bg-red-600 text-xs hover:bg-red-600'>Live</Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className='text-left'>
            Live view of this phone&apos;s camera. The camera only runs while this
            window is open.
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
          {streamUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={streamUrl}
              src={streamUrl}
              alt={`Camera of ${deviceName}`}
              onLoad={() => setStreamShowing(true)}
              onError={() => {
                setStreamShowing(false)
                // The stream ends with the session; reconnect once the phone streams again.
                if (state === 'streaming') setFallback(true)
              }}
              className={`max-h-[70vh] w-auto ${streamShowing ? '' : 'hidden'}`}
            />
          )}
          {fallback && pollImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pollImage}
              alt={`Camera of ${deviceName}`}
              className='max-h-[70vh] w-auto'
            />
          )}
          {!(streamShowing && !fallback) && !(fallback && pollImage) && (
            <div className='flex flex-col items-center gap-2 p-6 text-center text-xs text-white/70'>
              <Loader2 className='h-5 w-5 animate-spin' />
              {starting
                ? 'Waking the phone…'
                : state === 'connecting'
                  ? 'Phone received the request — starting the camera…'
                  : state === 'streaming'
                    ? 'Receiving the camera…'
                    : 'Waiting for the phone to answer…'}
            </div>
          )}
        </div>

        <div className='flex flex-wrap items-center justify-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={!live || busy}
            onClick={() => void command('switch')}
          >
            <SwitchCamera className='mr-1 h-4 w-4' /> Switch camera
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={!live || busy}
            onClick={() => void command('rotate')}
          >
            <RotateCw className='mr-1 h-4 w-4' /> Rotate
          </Button>
          <Button
            variant='ghost'
            size='sm'
            disabled={starting}
            onClick={() => {
              setFallback(false)
              setStreamShowing(false)
              void start()
            }}
          >
            <RefreshCw className={`mr-1 h-4 w-4 ${starting ? 'animate-spin' : ''}`} />
            Reconnect
          </Button>
        </div>
        <p className='text-center text-[11px] text-muted-foreground'>
          Viewing stops when you close this window, or after 30 minutes.
          {fallback ? ' (Compatibility mode: lower frame rate.)' : ''}
        </p>
      </DialogContent>
    </Dialog>
  )
}
