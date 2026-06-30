import { PropsWithChildren } from 'react'
import '@/styles/main.css'
import { Metadata } from 'next'
import Footer from '@/components/shared/footer'
import { Toaster } from '@/components/ui/toaster'
import Analytics from '@/components/shared/analytics'
import { Session } from 'next-auth'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export const metadata: Metadata = {
  title: 'Gabay SMS - SMS Gateway Dashboard',

  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://sms.gabay.online'),
}

export default async function RootLayout({ children }: PropsWithChildren) {
  return (
    <html lang='en'>
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
