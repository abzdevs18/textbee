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
}

module.exports = nextConfig
