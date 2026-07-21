'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Smartphone,
  Battery,
  Signal,
  Copy,
  Plus,
  ExternalLink,
  Loader2,
  MoreVertical,
  TriangleAlert,
  Power,
  PowerOff,
} from 'lucide-react'
import Link from 'next/link'
import { useToast } from '@/hooks/use-toast'
import httpBrowserClient from '@/lib/httpBrowserClient'
import { ApiEndpoints } from '@/config/api'
import { Routes } from '@/config/routes'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { formatDeviceName } from '@/lib/utils'
import { formatError } from '@/lib/utils/errorHandler'
import GenerateApiKey, {
  type GenerateApiKeyHandle,
} from './generate-api-key'
import {
  DeviceVersionCandidate,
  getDeviceVersionCode,
  isDeviceOutdated,
  latestAppVersionCode,
} from './update-app-helpers'

type DeviceRow = DeviceVersionCandidate & {
  createdAt: string
  status?: string
  enabled?: boolean
}

export default function DeviceList() {
  const addDeviceKeyRef = useRef<GenerateApiKeyHandle>(null)
  const [addDeviceInstructionOpen, setAddDeviceInstructionOpen] =
    useState(false)
  const [devicePendingDelete, setDevicePendingDelete] =
    useState<DeviceRow | null>(null)
  const [devicePendingDisable, setDevicePendingDisable] =
    useState<DeviceRow | null>(null)
  const [togglingDeviceId, setTogglingDeviceId] = useState<string | null>(null)
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const {
    isPending,
    error,
    data: devices,
  } = useQuery({
    queryKey: ['devices'],
    queryFn: () =>
      httpBrowserClient
        .get(ApiEndpoints.gateway.listDevices())
        .then((res) => res.data),
    // select: (res) => res.data,
  })

  const { data: currentSubscription } = useQuery({
    queryKey: ['currentSubscription'],
    queryFn: () =>
      httpBrowserClient
        .get(ApiEndpoints.billing.currentSubscription())
        .then((res) => res.data),
  })

  // -1 (or missing) means unlimited; only enabled devices count toward the limit
  const deviceLimit = currentSubscription?.usage?.deviceLimit ?? -1
  const activeDeviceCount =
    devices?.data?.filter((device) => device.enabled).length ?? 0
  const isDeviceLimitReached =
    deviceLimit !== -1 && !isPending && activeDeviceCount >= deviceLimit
  const isApproachingDeviceLimit =
    deviceLimit >= 2 && !isPending && activeDeviceCount === deviceLimit - 1

  const {
    mutate: setDeviceEnabled,
    isPending: isUpdatingDeviceEnabled,
  } = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      httpBrowserClient.patch(ApiEndpoints.gateway.updateDevice(id), {
        enabled,
      }),
    onMutate: ({ id }) => {
      setTogglingDeviceId(id)
    },
    onSuccess: (_data, variables) => {
      setDevicePendingDisable(null)
      setTogglingDeviceId(null)
      toast({
        title: variables.enabled ? 'Gateway enabled' : 'Gateway disabled',
        description: variables.enabled
          ? 'This device can send and receive SMS again.'
          : 'This device will not send or claim SMS until re-enabled.',
      })
      void queryClient.invalidateQueries({ queryKey: ['devices'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['currentSubscription'] })
    },
    onError: (err: unknown) => {
      setTogglingDeviceId(null)
      const { message } = formatError(err)
      toast({
        variant: 'destructive',
        title: 'Could not update device',
        description: message,
      })
    },
  })

  const {
    mutate: deleteDevice,
    isPending: isDeletingDevice,
  } = useMutation({
    mutationFn: (id: string) =>
      httpBrowserClient.delete(ApiEndpoints.gateway.deleteDevice(id)),
    onSuccess: () => {
      setDevicePendingDelete(null)
      toast({
        title: 'Device removed',
      })
      void queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (err: unknown) => {
      const { message } = formatError(err)
      toast({
        variant: 'destructive',
        title: 'Error removing device',
        description: message,
      })
    },
  })

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id)
    toast({
      title: 'Device ID copied to clipboard',
    })
  }

  return (
    <>
      <GenerateApiKey ref={addDeviceKeyRef} showTrigger={false} />
      <Card>
        <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
          <CardTitle className='text-lg'>Registered Devices</CardTitle>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setAddDeviceInstructionOpen(true)}
          >
            <Plus className='mr-1 h-4 w-4' />
            Add device
          </Button>
        </CardHeader>
      <CardContent>
          {(isDeviceLimitReached || isApproachingDeviceLimit) && (
            <div
              className={`mb-4 flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between ${
                isDeviceLimitReached
                  ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20'
                  : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
              }`}
            >
              <div className='flex items-start gap-2'>
                <TriangleAlert
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    isDeviceLimitReached
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                />
                <p className='text-xs text-muted-foreground'>
                  {isDeviceLimitReached ? (
                    <>
                      You've reached your plan's limit of{' '}
                      <span className='font-medium text-foreground'>
                        {deviceLimit} active device{deviceLimit === 1 ? '' : 's'}
                      </span>
                      . New devices can't be registered or re-enabled.
                    </>
                  ) : (
                    <>
                      You're using{' '}
                      <span className='font-medium text-foreground'>
                        {activeDeviceCount} of {deviceLimit}
                      </span>{' '}
                      active devices included in your plan.
                    </>
                  )}
                </p>
              </div>
              <Button variant='outline' size='sm' asChild className='shrink-0'>
                <Link href='/checkout/pro'>Upgrade plan</Link>
              </Button>
            </div>
          )}
          <div className='space-y-2'>
            {isPending && (
              <>
                {[1, 2, 3].map((i) => (
                  <Card key={i} className='border-0 shadow-none'>
                    <CardContent className='flex items-center p-3'>
                      <Skeleton className='h-6 w-6 rounded-full mr-3 shrink-0' />
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center justify-between'>
                          <Skeleton className='h-4 w-[120px]' />
                          <Skeleton className='h-4 w-[60px]' />
                        </div>
                        <div className='flex items-center space-x-2 mt-1'>
                          <Skeleton className='h-4 w-[180px]' />
                        </div>
                        <div className='flex items-center mt-1 space-x-3'>
                          <Skeleton className='h-3 w-[200px]' />
                        </div>
                      </div>
                      <Skeleton className='h-6 w-6 shrink-0' />
                    </CardContent>
                  </Card>
                ))}
              </>
            )}

            {error && (
              <div className='flex justify-center items-center h-full'>
                <div>Error: {error.message}</div>
              </div>
            )}

            {!isPending && !error && devices?.data?.length === 0 && (
              <div className='flex justify-center items-center h-full'>
                <div>No devices found</div>
              </div>
            )}

            {devices?.data?.map((device) => (
              <Card key={device._id} className='border-0 shadow-none'>
                <CardContent className='flex items-center gap-1 p-3'>
                  <Smartphone className='h-6 w-6 mr-2 shrink-0' />
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-center justify-between'>
                      <h3 className='font-semibold text-sm'>
                        {formatDeviceName(device)}
                      </h3>
                      <div className='flex items-center gap-2'>
                        {isDeviceOutdated(device as DeviceVersionCandidate) && (
                          <Badge
                            variant='outline'
                            className='border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                          >
                            Update available
                          </Badge>
                        )}
                        <Badge
                          variant={device.enabled ? 'default' : 'secondary'}
                          className={
                            device.enabled
                              ? 'text-xs bg-emerald-600 hover:bg-emerald-600'
                              : 'text-xs'
                          }
                        >
                          {device.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </div>
                    </div>
                    <div className='mt-2 flex flex-wrap items-center gap-3'>
                      <div className='flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5'>
                        <Switch
                          id={`gateway-switch-${device._id}`}
                          checked={!!device.enabled}
                          disabled={
                            isUpdatingDeviceEnabled &&
                            togglingDeviceId === device._id
                          }
                          onCheckedChange={(checked) => {
                            if (!checked) {
                              setDevicePendingDisable(device as DeviceRow)
                              return
                            }
                            // Re-enable immediately; server enforces device limit
                            setDeviceEnabled({
                              id: device._id,
                              enabled: true,
                            })
                          }}
                          aria-label={
                            device.enabled
                              ? 'Disable gateway for this device'
                              : 'Enable gateway for this device'
                          }
                        />
                        <Label
                          htmlFor={`gateway-switch-${device._id}`}
                          className='cursor-pointer text-xs font-medium text-muted-foreground'
                        >
                          {isUpdatingDeviceEnabled &&
                          togglingDeviceId === device._id ? (
                            <span className='inline-flex items-center gap-1'>
                              <Loader2 className='h-3 w-3 animate-spin' />
                              Updating…
                            </span>
                          ) : device.enabled ? (
                            'Gateway on'
                          ) : (
                            'Gateway off'
                          )}
                        </Label>
                      </div>
                      <div className='flex items-center space-x-2'>
                        <code className='relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-xs'>
                          {device._id}
                        </code>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-6 w-6'
                          onClick={() => handleCopyId(device._id)}
                        >
                          <Copy className='h-3 w-3' />
                        </Button>
                      </div>
                    </div>
                    <div className='flex items-center mt-1 space-x-3 text-xs text-muted-foreground'>
                      <div className='flex items-center'>
                        <Battery className='h-3 w-3 mr-1' />
                        unknown
                      </div>
                      <div className='flex items-center'>
                        <Signal className='h-3 w-3 mr-1' />-
                      </div>
                      <div>
                        App version:{' '}
                        {getDeviceVersionCode(device as DeviceVersionCandidate) ??
                          'unknown'}
                      </div>
                      <div>
                        Registered at:{' '}
                        {new Date(device.createdAt).toLocaleString('en-US', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </div>
                    </div>
                    {isDeviceOutdated(device as DeviceVersionCandidate) && (
                      <div className='mt-3 flex items-center justify-between gap-2 rounded-lg border border-brand-100 bg-brand-50/60 px-3 py-2 dark:border-brand-900/50 dark:bg-brand-950/20'>
                        <p className='text-xs text-muted-foreground'>
                          This device is behind the latest supported version{' '}
                          <span className='font-medium text-foreground'>
                            {latestAppVersionCode}
                          </span>
                          .
                        </p>
                        <Button
                          variant='outline'
                          size='sm'
                          asChild
                          className='shrink-0'
                        >
                          <a
                            href={Routes.downloadAndroidApp}
                            target='_blank'
                            rel='noreferrer'
                          >
                            Update app
                          </a>
                        </Button>
                      </div>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8 shrink-0'
                        aria-label='Device actions'
                      >
                        <MoreVertical className='h-4 w-4' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      {device.enabled ? (
                        <DropdownMenuItem
                          onClick={() =>
                            setDevicePendingDisable(device as DeviceRow)
                          }
                        >
                          <PowerOff className='mr-2 h-4 w-4' />
                          Disable gateway
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() =>
                            setDeviceEnabled({
                              id: device._id,
                              enabled: true,
                            })
                          }
                          disabled={
                            isUpdatingDeviceEnabled &&
                            togglingDeviceId === device._id
                          }
                        >
                          <Power className='mr-2 h-4 w-4' />
                          Enable gateway
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className='text-destructive focus:text-destructive'
                        onClick={() =>
                          setDevicePendingDelete(device as DeviceRow)
                        }
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardContent>
              </Card>
            ))}
          </div>
      </CardContent>
      </Card>

      <Dialog
        open={addDeviceInstructionOpen}
        onOpenChange={setAddDeviceInstructionOpen}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Add a device</DialogTitle>
            <DialogDescription className='text-left'>
              Register a new device by scanning the QR code or pasting the API key.
            </DialogDescription>
          </DialogHeader>
          <ol className='list-decimal space-y-3 pl-5 text-left text-sm text-muted-foreground'>
            <li>
              Download the Gabay SMS app from{' '}
              <a
                href={Routes.downloadAndroidApp}
                target='_blank'
                rel='noreferrer'
                className='font-medium text-primary underline-offset-4 hover:underline'
              >
                {Routes.downloadAndroidApp}
              </a>
              , install it, and grant SMS permissions.
            </li>
            <li>
              Tap Continue to create a new API key and get a QR
              code in the next dialog. If you already have an active API key, you can paste it in the
              app instead
            </li>
            <li>
              Open the Gabay SMS app and scan the QR code or paste the key manually. Your device should appear in the list when the link succeeds.
            </li>
          </ol>
          <DialogFooter className='flex-col gap-2 sm:flex-row sm:justify-between'>
            <Button variant='outline' size='sm' asChild>
              <a href={Routes.quickstart} target='_blank' rel='noreferrer'>
                Full guide
                <ExternalLink className='ml-1 h-3 w-3' />
              </a>
            </Button>
            <div className='flex w-full gap-2 sm:w-auto'>
              <Button
                variant='outline'
                size='sm'
                className='flex-1 sm:flex-none'
                onClick={() => setAddDeviceInstructionOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size='sm'
                className='flex-1 sm:flex-none'
                onClick={() => {
                  setAddDeviceInstructionOpen(false)
                  addDeviceKeyRef.current?.open()
                }}
              >
                Continue
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!devicePendingDisable}
        onOpenChange={(open) => {
          if (!open && !isUpdatingDeviceEnabled) setDevicePendingDisable(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable gateway?</DialogTitle>
            <DialogDescription>
              {devicePendingDisable
                ? `${formatDeviceName(devicePendingDisable)} will stop sending and claiming SMS. The phone stays registered — you can re-enable it anytime from this page.`
                : 'This device will stop sending and claiming SMS until you re-enable it.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDevicePendingDisable(null)}
              disabled={isUpdatingDeviceEnabled}
            >
              Cancel
            </Button>
            <Button
              variant='default'
              onClick={() =>
                devicePendingDisable &&
                setDeviceEnabled({
                  id: devicePendingDisable._id,
                  enabled: false,
                })
              }
              disabled={isUpdatingDeviceEnabled}
            >
              {isUpdatingDeviceEnabled ? (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              ) : (
                <PowerOff className='mr-2 h-4 w-4' />
              )}
              Disable gateway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!devicePendingDelete}
        onOpenChange={(open) => {
          if (!open) setDevicePendingDelete(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this device?</DialogTitle>
            <DialogDescription>
              {devicePendingDelete
                ? `This removes ${formatDeviceName(devicePendingDelete)} from your account. You will not be able to send or receive SMS through it until you register the app again.`
                : 'This removes the device from your account. You will not be able to send or receive SMS through it until you register the app again.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDevicePendingDelete(null)}
              disabled={isDeletingDevice}
            >
              Cancel
            </Button>
            <Button
              variant='destructive'
              onClick={() =>
                devicePendingDelete &&
                deleteDevice(devicePendingDelete._id)
              }
              disabled={isDeletingDevice}
            >
              {isDeletingDevice ? (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              ) : null}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
