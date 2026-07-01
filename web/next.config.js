/** @type {import('next').NextConfig} */
const standaloneOutput = process.env.NEXT_OUTPUT_MODE !== 'default'

const nextConfig = {
  reactStrictMode: true,
  i18n: {
    locales: ['en-US'],
    defaultLocale: 'en-US',
  },
  ...(standaloneOutput ? { output: 'standalone' } : {}),

  async redirects() {
    return [
      {
        source: '/',
        destination: '/dashboard',
        permanent: true,
      },
      {
        source: '/android',
        destination: '/download',
        permanent: false,
      },
    ]
  },

  async headers() {
    return [
      {
        source: '/downloads/gabay-sms-2.8.1.apk',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/vnd.android.package-archive',
          },
          {
            key: 'Content-Disposition',
            value: 'attachment; filename="gabay-sms-2.8.1.apk"',
          },
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
