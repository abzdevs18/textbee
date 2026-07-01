import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  ArrowDownToLine,
  CalendarDays,
  Check,
  FileCheck2,
  HardDriveDownload,
  Info,
  PackageCheck,
  Smartphone,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const androidRelease = {
  version: '2.8.3',
  versionCode: 21,
  releasedAt: 'July 1, 2026',
  minimumAndroid: 'Android 7.0+',
  fileName: 'gabay-sms-2.8.3.apk',
  fileSize: '13.64 MB',
  downloadUrl: '/downloads/gabay-sms-2.8.3.apk',
  sha256: '84C007F6877468B65D119919F88AF41E9D29C6398B7D429E3CB58090CD2197EE',
}

const installationSteps = [
  'Download the APK directly to your Android phone.',
  'Allow installation from your browser when Android asks for permission.',
  'Open Gabay SMS, scan your dashboard QR code, and register the device.',
]

export default function DownloadPage() {
  return (
    <main className='min-h-screen bg-slate-50 px-4 py-12 dark:bg-slate-950 sm:py-16'>
      <div className='mx-auto max-w-5xl space-y-8'>
        <section className='relative overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50 p-8 shadow-sm dark:border-emerald-900 dark:bg-emerald-950/40 sm:p-10'>
          <div className='relative z-10 max-w-3xl'>
            <Badge className='mb-5 rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'>
              <PackageCheck className='mr-2 h-4 w-4' /> Official self-hosted APK
            </Badge>
            <h1 className='text-3xl font-bold tracking-tight text-emerald-950 dark:text-white sm:text-4xl'>
              Download Gabay SMS for Android
            </h1>
            <p className='mt-4 max-w-2xl text-base leading-7 text-emerald-800 dark:text-emerald-200 sm:text-lg'>
              Turn your Android phone into an SMS gateway connected directly to
              your Gabay SMS dashboard.
            </p>

            <div className='mt-7 flex flex-col gap-3 sm:flex-row'>
              <Button
                size='lg'
                className='rounded-lg bg-[#3d8216] px-6 text-white shadow-sm hover:bg-[#2a5a10]'
                asChild
              >
                <a href={androidRelease.downloadUrl} download={androidRelease.fileName}>
                  <ArrowDownToLine className='mr-2 h-5 w-5' />
                  Download APK
                </a>
              </Button>
              <Button size='lg' variant='outline' className='rounded-lg bg-white' asChild>
                <Link href='/dashboard'>Open dashboard</Link>
              </Button>
            </div>
          </div>

          <Smartphone className='absolute -bottom-8 -right-6 h-56 w-56 text-emerald-900/5 dark:text-white/5' />
        </section>

        <section className='rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-8'>
          <div className='flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between'>
            <div>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 className='text-2xl font-semibold text-slate-900 dark:text-white'>
                  Gabay SMS {androidRelease.version}
                </h2>
                <Badge className='rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900 dark:text-emerald-200'>
                  Latest
                </Badge>
              </div>
              <p className='mt-2 text-sm text-slate-500 dark:text-slate-400'>
                Production flavor · version code {androidRelease.versionCode}
              </p>
            </div>

            <Button
              className='rounded-lg bg-[#3d8216] text-white hover:bg-[#2a5a10]'
              asChild
            >
              <a href={androidRelease.downloadUrl} download={androidRelease.fileName}>
                <HardDriveDownload className='mr-2 h-4 w-4' />
                {androidRelease.fileName}
              </a>
            </Button>
          </div>

          <div className='mt-6 grid gap-3 sm:grid-cols-3'>
            <ReleaseDetail
              icon={<CalendarDays className='h-4 w-4' />}
              label='Released'
              value={androidRelease.releasedAt}
            />
            <ReleaseDetail
              icon={<HardDriveDownload className='h-4 w-4' />}
              label='File size'
              value={androidRelease.fileSize}
            />
            <ReleaseDetail
              icon={<Smartphone className='h-4 w-4' />}
              label='Compatibility'
              value={androidRelease.minimumAndroid}
            />
          </div>

          <div className='mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950'>
            <div className='flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-white'>
              <FileCheck2 className='h-4 w-4 text-[#3d8216]' /> SHA-256 checksum
            </div>
            <code className='mt-2 block break-all text-xs leading-5 text-slate-600 dark:text-slate-400'>
              {androidRelease.sha256}
            </code>
          </div>
        </section>

        <div className='grid gap-6 lg:grid-cols-2'>
          <section className='rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900'>
            <h2 className='text-lg font-semibold text-slate-900 dark:text-white'>
              Install in three steps
            </h2>
            <ol className='mt-5 space-y-4'>
              {installationSteps.map((step, index) => (
                <li key={step} className='flex gap-3 text-sm leading-6 text-slate-600 dark:text-slate-300'>
                  <span className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#3d8216]/10 text-xs font-semibold text-[#3d8216]'>
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className='rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900'>
            <h2 className='text-lg font-semibold text-slate-900 dark:text-white'>
              Device requirements
            </h2>
            <ul className='mt-5 space-y-3 text-sm text-slate-600 dark:text-slate-300'>
              {[
                'Android 7.0 (Nougat) or newer',
                'An active SIM with SMS capability',
                'Internet access for API communication',
                'Background operation allowed for reliable delivery',
              ].map((requirement) => (
                <li key={requirement} className='flex items-start gap-3'>
                  <Check className='mt-0.5 h-4 w-4 shrink-0 text-emerald-600' />
                  <span>{requirement}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className='flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'>
          <Info className='mt-0.5 h-5 w-5 shrink-0 text-amber-600' />
          <p>
            Android may ask you to allow installation from your browser. Only
            install the APK downloaded from this page, and compare its checksum
            if you need to verify the file.
          </p>
        </section>
      </div>
    </main>
  )
}

function ReleaseDetail({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950'>
      <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500'>
        {icon}
        {label}
      </div>
      <div className='mt-2 text-sm font-semibold text-slate-900 dark:text-white'>
        {value}
      </div>
    </div>
  )
}
