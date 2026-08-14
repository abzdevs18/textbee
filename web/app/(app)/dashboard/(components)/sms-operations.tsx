'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarDays,
  Check,
  Clock,
  History,
  Loader2,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  Search,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ApiEndpoints } from '@/config/api'
import { toast } from '@/hooks/use-toast'
import httpBrowserClient from '@/lib/httpBrowserClient'
import { formatDeviceName } from '@/lib/utils'
import { formatError } from '@/lib/utils/errorHandler'

type SmsMessage = {
  _id: string
  message?: string
  recipient?: string
  sender?: string
  type?: string
  status?: string
  requestedAt?: string
  queuedAt?: string
  scheduledAt?: string
  dispatchedAt?: string
  sentAt?: string
  deliveredAt?: string
  failedAt?: string
  canceledAt?: string
  receivedAt?: string
  createdAt?: string
  queueJobId?: string
  errorCode?: string
  errorMessage?: string
  device?: {
    _id: string
    brand?: string
    model?: string
    buildId?: string
    enabled?: boolean
    name?: string
  }
}

type MessageResponse = {
  data: SmsMessage[]
  meta: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  summary: Record<string, number>
}

type ResendResponse = {
  success: boolean
  resent: number
  skipped: number
  failed: number
}

type DeleteResponse = {
  success: boolean
  deleted: number
  skippedActive?: number
  notFoundOrNotOwned?: number
}

const EMPTY_MESSAGES: SmsMessage[] = []

const statusOptions = [
  { value: 'pending', label: 'Pending' },
  { value: 'all', label: 'All statuses' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'sent', label: 'Sent' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'received', label: 'Received' },
  { value: 'canceled', label: 'Canceled' },
]

const typeOptions = [
  { value: 'all', label: 'All messages' },
  { value: 'sent', label: 'Sent only' },
  { value: 'received', label: 'Received only' },
]

const formatTimestamp = (timestamp?: string) => {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const getPrimaryTimestamp = (message: SmsMessage) =>
  message.scheduledAt ||
  message.queuedAt ||
  message.requestedAt ||
  message.receivedAt ||
  message.createdAt

const formatSmsDeviceName = (device?: SmsMessage['device']) => {
  if (!device) return 'Unknown'
  return formatDeviceName({
    brand: device.brand || 'Unknown',
    model: device.model || 'device',
    name: device.name,
  })
}

const isResendableMessage = (message: SmsMessage) => {
  const status = (message.status || '').toLowerCase()
  const type = (message.type || '').toLowerCase()
  return (
    type !== 'received' &&
    !['pending', 'dispatched'].includes(status) &&
    Boolean(message.message && message.recipient)
  )
}

const isDeletableMessage = (message: SmsMessage) =>
  !['pending', 'dispatched'].includes((message.status || '').toLowerCase())

const getDateBoundaryIso = (date: string, endOfDay = false) => {
  if (!date) return undefined
  const timestamp = endOfDay ? `${date}T23:59:59.999` : `${date}T00:00:00.000`
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

const getStatusBadge = (status?: string) => {
  const normalized = (status || 'pending').toLowerCase()
  switch (normalized) {
    case 'pending':
      return {
        className: 'bg-amber-50 text-amber-800 border-amber-200',
        icon: <Clock className='h-3 w-3' />,
        label: 'Pending',
      }
    case 'dispatched':
      return {
        className: 'bg-slate-50 text-slate-700 border-slate-200',
        icon: <ArrowRightLeft className='h-3 w-3' />,
        label: 'Dispatched',
      }
    case 'sent':
    case 'delivered':
    case 'received':
      return {
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        icon: <Check className='h-3 w-3' />,
        label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
      }
    case 'failed':
      return {
        className: 'bg-red-50 text-red-700 border-red-200',
        icon: <X className='h-3 w-3' />,
        label: 'Failed',
      }
    case 'canceled':
      return {
        className: 'bg-slate-50 text-slate-600 border-slate-200',
        icon: <X className='h-3 w-3' />,
        label: 'Canceled',
      }
    default:
      return {
        className: 'bg-slate-50 text-slate-700 border-slate-200',
        icon: <AlertTriangle className='h-3 w-3' />,
        label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
      }
  }
}

export default function SmsOperations() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [deviceId, setDeviceId] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [rerouteMessage, setRerouteMessage] = useState<SmsMessage | null>(null)
  const [targetDeviceId, setTargetDeviceId] = useState('')
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([])
  const [resendDialogOpen, setResendDialogOpen] = useState(false)
  const [resendMessageIds, setResendMessageIds] = useState<string[]>([])
  const [resendTargetDeviceId, setResendTargetDeviceId] = useState('original')

  const { data: devices, isLoading: isLoadingDevices } = useQuery({
    queryKey: ['devices'],
    queryFn: () =>
      httpBrowserClient
        .get(ApiEndpoints.gateway.listDevices())
        .then((res) => res.data),
  })

  const queryParams = useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('limit', '25')
    params.set('status', status)
    params.set('type', type)
    if (deviceId !== 'all') params.set('deviceId', deviceId)
    if (search.trim()) params.set('search', search.trim())
    const from = getDateBoundaryIso(dateFrom)
    const to = getDateBoundaryIso(dateTo, true)
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    return params
  }, [dateFrom, dateTo, deviceId, page, search, status, type])

  const {
    data: messagesResponse,
    isLoading: isLoadingMessages,
    isFetching,
    refetch,
  } = useQuery<MessageResponse>({
    queryKey: ['sms-operations', queryParams.toString()],
    queryFn: () =>
      httpBrowserClient
        .get(`${ApiEndpoints.gateway.listAccountMessages()}?${queryParams}`)
        .then((res) => res.data),
  })

  const invalidateMessages = () => {
    queryClient.invalidateQueries({ queryKey: ['sms-operations'] })
    queryClient.invalidateQueries({ queryKey: ['messages-history'] })
  }

  const cancelMutation = useMutation({
    mutationFn: (smsId: string) =>
      httpBrowserClient.post(ApiEndpoints.gateway.cancelMessage(smsId), {
        reason: 'Canceled from SMS operations dashboard',
      }),
    onSuccess: () => {
      toast({ title: 'Pending SMS canceled.' })
      invalidateMessages()
    },
    onError: (error) => {
      const formatted = formatError(error)
      toast({
        title: 'Unable to cancel SMS.',
        description: formatted.message,
        variant: 'destructive',
      })
    },
  })

  const rerouteMutation = useMutation({
    mutationFn: ({
      smsId,
      targetDeviceId,
    }: {
      smsId: string
      targetDeviceId: string
    }) =>
      httpBrowserClient.post(ApiEndpoints.gateway.rerouteMessage(smsId), {
        targetDeviceId,
      }),
    onSuccess: () => {
      toast({ title: 'Pending SMS rerouted.' })
      setRerouteMessage(null)
      setTargetDeviceId('')
      invalidateMessages()
    },
    onError: (error) => {
      const formatted = formatError(error)
      toast({
        title: 'Unable to reroute SMS.',
        description: formatted.message,
        variant: 'destructive',
      })
    },
  })

  const deleteMatchingMutation = useMutation({
    mutationFn: () => {
      const params = new URLSearchParams(queryParams)
      params.delete('page')
      params.delete('limit')
      return httpBrowserClient.delete(
        `${ApiEndpoints.gateway.deleteMatchingMessages()}?${params}`,
      )
    },
    onSuccess: (response) => {
      const deleted = response.data?.deleted ?? 0
      const skipped = response.data?.skippedActive ?? 0
      toast({
        title: 'Message records permanently deleted.',
        description:
          skipped > 0
            ? `${deleted} record(s) deleted. ${skipped} active pending/dispatched record(s) were protected.`
            : `${deleted} record(s) deleted.`,
      })
      setPage(1)
      setSelectedMessageIds([])
      invalidateMessages()
    },
    onError: (error) => {
      const formatted = formatError(error)
      toast({
        title: 'Unable to delete message records.',
        description: formatted.message,
        variant: 'destructive',
      })
    },
  })

  const deleteSelectedMutation = useMutation({
    mutationFn: (smsIds: string[]) =>
      httpBrowserClient.post(ApiEndpoints.gateway.deleteMessages(), { smsIds }),
    onSuccess: (response) => {
      const result = (response.data || {}) as DeleteResponse
      const deleted = result.deleted ?? 0
      const skipped = result.skippedActive ?? 0
      toast({
        title: 'Selected records permanently deleted.',
        description:
          skipped > 0
            ? `${deleted} record(s) deleted. ${skipped} active record(s) were protected.`
            : `${deleted} record(s) deleted.`,
      })
      setSelectedMessageIds([])
      invalidateMessages()
    },
    onError: (error) => {
      const formatted = formatError(error)
      toast({
        title: 'Unable to delete selected records.',
        description: formatted.message,
        variant: 'destructive',
      })
    },
  })

  const deleteMessageMutation = useMutation({
    mutationFn: (smsId: string) =>
      httpBrowserClient.delete(ApiEndpoints.gateway.deleteMessage(smsId)),
    onSuccess: () => {
      toast({ title: 'Message record permanently deleted.' })
      invalidateMessages()
    },
    onError: (error) => {
      const formatted = formatError(error)
      toast({
        title: 'Unable to delete message record.',
        description: formatted.message,
        variant: 'destructive',
      })
    },
  })

  const resendMutation = useMutation({
    mutationFn: ({
      smsIds,
      targetDeviceId,
    }: {
      smsIds: string[]
      targetDeviceId?: string
    }) =>
      httpBrowserClient.post(ApiEndpoints.gateway.resendMessages(), {
        smsIds,
        ...(targetDeviceId && targetDeviceId !== 'original'
          ? { targetDeviceId }
          : {}),
      }),
    onSuccess: (response) => {
      const result = (response.data || {}) as ResendResponse
      const resent = result.resent ?? 0
      const skipped = result.skipped ?? 0
      const failed = result.failed ?? 0

      toast({
        title: resent > 0 ? 'SMS resend queued.' : 'No SMS resent.',
        description: `${resent} resent, ${skipped} skipped, ${failed} failed.`,
        variant: resent === 0 && failed > 0 ? 'destructive' : undefined,
      })
      setResendDialogOpen(false)
      setResendMessageIds([])
      invalidateMessages()
    },
    onError: (error) => {
      const formatted = formatError(error)
      toast({
        title: 'Unable to resend SMS.',
        description: formatted.message,
        variant: 'destructive',
      })
    },
  })

  const messages = messagesResponse?.data || EMPTY_MESSAGES
  const meta = messagesResponse?.meta || {
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 1,
  }
  const summary = messagesResponse?.summary || {}
  const deviceList = devices?.data || []
  const visibleResendableIds = useMemo(
    () => messages.filter(isResendableMessage).map((message) => message._id),
    [messages],
  )
  const visibleDeletableIds = useMemo(
    () => messages.filter(isDeletableMessage).map((message) => message._id),
    [messages],
  )
  const selectedResendableIds = selectedMessageIds.filter((smsId) =>
    visibleResendableIds.includes(smsId),
  )
  const selectedVisibleCount = selectedMessageIds.filter((smsId) =>
    visibleDeletableIds.includes(smsId),
  ).length
  const allVisibleSelected =
    visibleDeletableIds.length > 0 &&
    selectedVisibleCount === visibleDeletableIds.length
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected

  useEffect(() => {
    setSelectedMessageIds((current) =>
      current.filter((smsId) => messages.some((message) => message._id === smsId)),
    )
  }, [messages])

  const handleApplySearch = () => {
    setPage(1)
    setSelectedMessageIds([])
    setSearch(searchInput)
  }

  const handleFilterChange = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setPage(1)
    setSelectedMessageIds([])
  }

  const handleDateFromChange = (value: string) => {
    setDateFrom(value)
    if (dateTo && value && dateTo < value) {
      setDateTo(value)
    }
    setPage(1)
    setSelectedMessageIds([])
  }

  const handleDateToChange = (value: string) => {
    setDateTo(value)
    if (dateFrom && value && dateFrom > value) {
      setDateFrom(value)
    }
    setPage(1)
    setSelectedMessageIds([])
  }

  const clearDateRange = () => {
    setDateFrom('')
    setDateTo('')
    setPage(1)
    setSelectedMessageIds([])
  }

  const openRerouteDialog = (message: SmsMessage) => {
    setRerouteMessage(message)
    const fallbackDevice = deviceList.find(
      (device: any) => device.enabled && device._id !== message.device?._id,
    )
    setTargetDeviceId(fallbackDevice?._id || '')
  }

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedMessageIds((current) => {
      const currentSet = new Set(current)
      if (checked) {
        visibleDeletableIds.forEach((smsId) => currentSet.add(smsId))
      } else {
        visibleDeletableIds.forEach((smsId) => currentSet.delete(smsId))
      }
      return Array.from(currentSet)
    })
  }

  const toggleMessageSelection = (smsId: string, checked: boolean) => {
    setSelectedMessageIds((current) =>
      checked
        ? Array.from(new Set([...current, smsId]))
        : current.filter((selectedId) => selectedId !== smsId),
    )
  }

  const openResendDialog = (smsIds = selectedMessageIds) => {
    const resendableIds = smsIds.filter((smsId) =>
      visibleResendableIds.includes(smsId),
    )
    setResendMessageIds(resendableIds)
    setResendTargetDeviceId('original')
    setResendDialogOpen(true)
  }

  const pendingCount = summary.pending || 0
  const completedCount =
    (summary.sent || 0) + (summary.delivered || 0) + (summary.received || 0)
  const issueCount = (summary.failed || 0) + (summary.unknown || 0)

  return (
    <div className='space-y-6'>
      <div className='grid gap-4 md:grid-cols-4'>
        <Card className='rounded-xl border-amber-200 bg-amber-50/70 shadow-sm'>
          <CardContent className='p-4'>
            <div className='flex items-center gap-3'>
              <span className='flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700'>
                <Clock className='h-5 w-5' />
              </span>
              <div>
                <p className='text-xs font-medium text-amber-800'>Pending</p>
                <p className='text-2xl font-semibold text-amber-900'>
                  {pendingCount}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className='rounded-xl border-slate-200 bg-white shadow-sm'>
          <CardContent className='p-4'>
            <div className='flex items-center gap-3'>
              <span className='flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600'>
                <ArrowRightLeft className='h-5 w-5' />
              </span>
              <div>
                <p className='text-xs font-medium text-slate-500'>Dispatched</p>
                <p className='text-2xl font-semibold text-slate-900'>
                  {summary.dispatched || 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className='rounded-xl border-emerald-200 bg-emerald-50/70 shadow-sm'>
          <CardContent className='p-4'>
            <div className='flex items-center gap-3'>
              <span className='flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700'>
                <Check className='h-5 w-5' />
              </span>
              <div>
                <p className='text-xs font-medium text-emerald-800'>Completed</p>
                <p className='text-2xl font-semibold text-emerald-900'>
                  {completedCount}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className='rounded-xl border-red-200 bg-red-50/70 shadow-sm'>
          <CardContent className='p-4'>
            <div className='flex items-center gap-3'>
              <span className='flex h-10 w-10 items-center justify-center rounded-xl bg-red-100 text-red-600'>
                <AlertTriangle className='h-5 w-5' />
              </span>
              <div>
                <p className='text-xs font-medium text-red-700'>Needs review</p>
                <p className='text-2xl font-semibold text-red-800'>
                  {issueCount}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className='rounded-2xl border-slate-200 shadow-sm'>
        <CardHeader className='p-6 pb-4'>
          <div className='flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between'>
            <div>
              <CardTitle className='flex items-center gap-2 text-lg font-semibold text-slate-900'>
                <MessageSquareText className='h-5 w-5 text-[#3d8216]' />
                SMS queue and history
              </CardTitle>
              <p className='mt-1 text-sm text-slate-500'>
                Cancel or reroute SMS only while they are still pending in the
                queue. Failed or unknown messages can be resent, and devices are
                paused after 5 active or 5 recent failed/unknown sends.
              </p>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                variant='outline'
                className='rounded-lg border-[#3d8216]/30 text-[#3d8216] hover:bg-[#3d8216]/5'
                disabled={selectedResendableIds.length === 0 || resendMutation.isPending}
                onClick={() => openResendDialog(selectedResendableIds)}
              >
                {resendMutation.isPending ? (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                ) : (
                  <RotateCcw className='mr-2 h-4 w-4' />
                )}
                Resend selected
                {selectedResendableIds.length > 0
                  ? ` (${selectedResendableIds.length})`
                  : ''}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant='outline'
                    className='rounded-lg border-red-200 text-red-600 hover:bg-red-50'
                    disabled={
                      selectedMessageIds.length === 0 ||
                      deleteSelectedMutation.isPending
                    }
                  >
                    {deleteSelectedMutation.isPending ? (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    ) : (
                      <Trash2 className='mr-2 h-4 w-4' />
                    )}
                    Delete selected
                    {selectedMessageIds.length > 0
                      ? ` (${selectedMessageIds.length})`
                      : ''}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className='rounded-2xl'>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Permanently delete selected messages?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes {selectedMessageIds.length}{' '}
                      selected database record(s). This cannot be undone.
                      Pending and dispatched messages are protected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep messages</AlertDialogCancel>
                    <AlertDialogAction
                      className='bg-red-600 text-white hover:bg-red-700'
                      onClick={() =>
                        deleteSelectedMutation.mutate(selectedMessageIds)
                      }
                    >
                      Delete permanently
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                variant='outline'
                className='rounded-lg'
                onClick={() => refetch()}
                disabled={isFetching}
              >
                {isFetching ? (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                ) : (
                  <RefreshCw className='mr-2 h-4 w-4' />
                )}
                Refresh
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant='outline'
                    className='rounded-lg border-red-200 text-red-600 hover:bg-red-50'
                    disabled={deleteMatchingMutation.isPending}
                  >
                    {deleteMatchingMutation.isPending ? (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    ) : (
                      <Trash2 className='mr-2 h-4 w-4' />
                    )}
                    Delete matching
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className='rounded-2xl'>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Permanently delete matching history?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently deletes every non-active database record
                      matching the current filters, including records hidden by
                      the previous clear-history behavior. This cannot be undone.
                      Pending and dispatched messages are protected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep messages</AlertDialogCancel>
                    <AlertDialogAction
                      className='bg-red-600 text-white hover:bg-red-700'
                      onClick={() => deleteMatchingMutation.mutate()}
                    >
                      Delete permanently
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>

        <CardContent className='space-y-4 p-6 pt-0'>
          <div className='grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_180px_220px]'>
            <div className='relative'>
              <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400' />
              <input
                type='text'
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleApplySearch()
                }}
                placeholder='Search number, message, status, or error...'
                className='h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none transition-all placeholder-gray-400 focus:border-[#1e6b20] focus:ring-4 focus:ring-green-500/10'
              />
            </div>
            <Select value={status} onValueChange={handleFilterChange(setStatus)}>
              <SelectTrigger className='h-10 rounded-lg bg-white'>
                <SelectValue placeholder='Status' />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={type} onValueChange={handleFilterChange(setType)}>
              <SelectTrigger className='h-10 rounded-lg bg-white'>
                <SelectValue placeholder='Type' />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className='flex gap-2'>
              <Select
                value={deviceId}
                onValueChange={handleFilterChange(setDeviceId)}
                disabled={isLoadingDevices}
              >
                <SelectTrigger className='h-10 rounded-lg bg-white'>
                  <SelectValue placeholder='Device' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>All devices</SelectItem>
                  {deviceList.map((device: any) => (
                    <SelectItem key={device._id} value={device._id}>
                      {formatDeviceName(device)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className='h-10 rounded-lg bg-[#3d8216] px-4 text-white hover:bg-[#2a5a10]'
                onClick={handleApplySearch}
              >
                Search
              </Button>
            </div>
          </div>

          <div className='flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3 lg:flex-row lg:items-center lg:justify-between'>
            <div className='flex items-center gap-2 text-sm font-medium text-slate-700'>
              <span className='flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[#3d8216] shadow-sm'>
                <CalendarDays className='h-4 w-4' />
              </span>
              Date range
              {(dateFrom || dateTo) && (
                <span className='text-xs font-normal text-slate-500'>
                  Filtering by message time
                </span>
              )}
            </div>
            <div className='grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:w-auto'>
              <label className='space-y-1'>
                <span className='text-xs font-medium text-slate-500'>From</span>
                <input
                  type='date'
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => handleDateFromChange(event.target.value)}
                  className='h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition-all focus:border-[#1e6b20] focus:ring-4 focus:ring-green-500/10'
                />
              </label>
              <label className='space-y-1'>
                <span className='text-xs font-medium text-slate-500'>To</span>
                <input
                  type='date'
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => handleDateToChange(event.target.value)}
                  className='h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition-all focus:border-[#1e6b20] focus:ring-4 focus:ring-green-500/10'
                />
              </label>
              <Button
                variant='outline'
                className='mt-5 h-10 rounded-lg bg-white'
                disabled={!dateFrom && !dateTo}
                onClick={clearDateRange}
              >
                Clear dates
              </Button>
            </div>
          </div>

          <div className='overflow-hidden rounded-xl border border-slate-200'>
            <Table>
              <TableHeader>
                <TableRow className='bg-slate-50'>
                  <TableHead className='w-10 px-4'>
                    <Checkbox
                      aria-label='Select visible deletable SMS'
                      checked={
                        allVisibleSelected
                          ? true
                          : someVisibleSelected
                            ? 'indeterminate'
                            : false
                      }
                      disabled={visibleDeletableIds.length === 0}
                      onCheckedChange={(checked) =>
                        toggleVisibleSelection(checked === true)
                      }
                    />
                  </TableHead>
                  <TableHead className='px-4'>Message</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Device used</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className='text-right'>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingMessages ? (
                  <TableRow>
                    <TableCell colSpan={7} className='py-12 text-center'>
                      <Loader2 className='mx-auto h-6 w-6 animate-spin text-muted-foreground' />
                    </TableCell>
                  </TableRow>
                ) : messages.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className='py-12 text-center'>
                      <div className='mx-auto flex max-w-sm flex-col items-center gap-2 text-slate-500'>
                        <History className='h-8 w-8 text-slate-300' />
                        <p className='text-sm font-medium text-slate-700'>
                          No matching SMS found
                        </p>
                        <p className='text-xs'>
                          Try changing the status filter or search term.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  messages.map((message) => {
                    const badge = getStatusBadge(message.status)
                    const isPending = message.status === 'pending'
                    const canResend = isResendableMessage(message)
                    const canDelete = isDeletableMessage(message)
                    const isSelected = selectedMessageIds.includes(message._id)
                    const number = message.recipient || message.sender || '—'
                    return (
                      <TableRow key={message._id}>
                        <TableCell className='px-4'>
                          <Checkbox
                            aria-label={`Select SMS ${number}`}
                            checked={isSelected}
                            disabled={!canDelete}
                            onCheckedChange={(checked) =>
                              toggleMessageSelection(message._id, checked === true)
                            }
                          />
                        </TableCell>
                        <TableCell className='max-w-[320px] px-4'>
                          <div className='space-y-1'>
                            <p className='line-clamp-2 text-sm text-slate-900'>
                              {message.message || '—'}
                            </p>
                            {message.errorMessage && (
                              <p className='line-clamp-1 text-xs text-red-600'>
                                {message.errorMessage}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className='font-mono text-xs'>{number}</TableCell>
                        <TableCell>
                          <Badge
                            variant='outline'
                            className={`inline-flex items-center gap-1 rounded-full ${badge.className}`}
                          >
                            {badge.icon}
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className='flex items-center gap-2 text-sm text-slate-700'>
                            <Smartphone className='h-4 w-4 text-slate-400' />
                            <span>
                              {formatSmsDeviceName(message.device)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className='text-xs text-slate-500'>
                          {formatTimestamp(getPrimaryTimestamp(message))}
                        </TableCell>
                        <TableCell className='text-right'>
                          <div className='flex justify-end gap-2'>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant='outline'
                                  size='sm'
                                  className='rounded-lg'
                                  disabled={!isPending || cancelMutation.isPending}
                                >
                                  Cancel
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent className='rounded-2xl'>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    Cancel this pending SMS?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This only works if the queue job is still
                                    waiting or delayed. If the phone already
                                    received the command, the server will refuse
                                    the cancellation.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Keep SMS</AlertDialogCancel>
                                  <AlertDialogAction
                                    className='bg-red-600 text-white hover:bg-red-700'
                                    onClick={() =>
                                      cancelMutation.mutate(message._id)
                                    }
                                  >
                                    Cancel pending SMS
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                            <Button
                              variant='outline'
                              size='sm'
                              className='rounded-lg border-[#3d8216]/30 text-[#3d8216] hover:bg-[#3d8216]/5'
                              disabled={!isPending}
                              onClick={() => openRerouteDialog(message)}
                            >
                              Reroute
                            </Button>
                            <Button
                              variant='outline'
                              size='sm'
                              className='rounded-lg border-[#3d8216]/30 text-[#3d8216] hover:bg-[#3d8216]/5'
                              disabled={!canResend || resendMutation.isPending}
                              onClick={() => openResendDialog([message._id])}
                            >
                              Resend
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant='outline'
                                  size='sm'
                                  className='rounded-lg border-red-200 text-red-600 hover:bg-red-50'
                                  disabled={
                                    !canDelete || deleteMessageMutation.isPending
                                  }
                                >
                                  Delete
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent className='rounded-2xl'>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    Permanently delete this message?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This removes the SMS record from the database
                                    and cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Keep message</AlertDialogCancel>
                                  <AlertDialogAction
                                    className='bg-red-600 text-white hover:bg-red-700'
                                    onClick={() =>
                                      deleteMessageMutation.mutate(message._id)
                                    }
                                  >
                                    Delete permanently
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className='flex flex-col gap-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between'>
            <span>
              Showing page {meta.page} of {Math.max(meta.totalPages, 1)} ·{' '}
              {meta.total} record(s)
            </span>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                className='rounded-lg'
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <Button
                variant='outline'
                size='sm'
                className='rounded-lg'
                disabled={page >= meta.totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={resendDialogOpen} onOpenChange={setResendDialogOpen}>
        <DialogContent className='rounded-2xl'>
          <DialogHeader>
            <DialogTitle>Resend selected SMS</DialogTitle>
            <DialogDescription>
              This creates fresh outbound SMS records from the selected history
              rows. Pending and dispatched messages are skipped automatically.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <div className='rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-sm text-emerald-900'>
              <p className='font-medium'>
                {resendMessageIds.length} SMS selected for resend
              </p>
              <p className='mt-1 text-xs text-emerald-800'>
                The server will pause any device that already has 5
                pending/dispatched SMS, or 5 failed/unknown SMS in the last 5
                hours.
              </p>
            </div>
            <Select
              value={resendTargetDeviceId}
              onValueChange={setResendTargetDeviceId}
            >
              <SelectTrigger className='rounded-lg'>
                <SelectValue placeholder='Choose resend device' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='original'>Original device from history</SelectItem>
                {deviceList.map((device: any) => (
                  <SelectItem
                    key={device._id}
                    value={device._id}
                    disabled={!device.enabled}
                  >
                    {formatDeviceName(device)} {device.enabled ? '' : '(disabled)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              className='rounded-lg'
              onClick={() => setResendDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className='rounded-lg bg-[#3d8216] text-white hover:bg-[#2a5a10]'
              disabled={resendMessageIds.length === 0 || resendMutation.isPending}
              onClick={() =>
                resendMutation.mutate({
                  smsIds: resendMessageIds,
                  targetDeviceId: resendTargetDeviceId,
                })
              }
            >
              {resendMutation.isPending && (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              )}
              Resend SMS
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rerouteMessage} onOpenChange={(open) => !open && setRerouteMessage(null)}>
        <DialogContent className='rounded-2xl'>
          <DialogHeader>
            <DialogTitle>Reroute pending SMS</DialogTitle>
            <DialogDescription>
              Choose another enabled device. The server will only reroute if the
              SMS is still waiting in the queue.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <div className='rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600'>
              <p className='font-medium text-slate-900'>
                {rerouteMessage?.recipient || rerouteMessage?.sender || 'Unknown number'}
              </p>
              <p className='mt-1 line-clamp-3'>{rerouteMessage?.message}</p>
            </div>
            <Select value={targetDeviceId} onValueChange={setTargetDeviceId}>
              <SelectTrigger className='rounded-lg'>
                <SelectValue placeholder='Select target device' />
              </SelectTrigger>
              <SelectContent>
                {deviceList
                  .filter((device: any) => device._id !== rerouteMessage?.device?._id)
                  .map((device: any) => (
                    <SelectItem
                      key={device._id}
                      value={device._id}
                      disabled={!device.enabled}
                    >
                      {formatDeviceName(device)} {device.enabled ? '' : '(disabled)'}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              className='rounded-lg'
              onClick={() => setRerouteMessage(null)}
            >
              Cancel
            </Button>
            <Button
              className='rounded-lg bg-[#3d8216] text-white hover:bg-[#2a5a10]'
              disabled={!targetDeviceId || rerouteMutation.isPending || !rerouteMessage}
              onClick={() =>
                rerouteMessage &&
                rerouteMutation.mutate({
                  smsId: rerouteMessage._id,
                  targetDeviceId,
                })
              }
            >
              {rerouteMutation.isPending && (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              )}
              Reroute SMS
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
