'use client'

import { ListChecks } from 'lucide-react'

import SmsOperations from '../(components)/sms-operations'

export default function MessagesPage() {
  return (
    <div className='flex-1 space-y-6 p-6 md:p-8'>
      <div className='space-y-1'>
        <div className='flex items-center space-x-2'>
          <ListChecks className='h-6 w-6 text-[#3d8216]' />
          <h2 className='text-3xl font-bold tracking-tight'>
            SMS Queue & History
          </h2>
        </div>
        <p className='text-muted-foreground'>
          Review pending SMS, reroute queued sends, and search or clear message
          history.
        </p>
      </div>

      <SmsOperations />
    </div>
  )
}
