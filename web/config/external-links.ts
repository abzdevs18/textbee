const POLAR_CUSTOMER_PORTAL_REQUEST_BASE =
  process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_REQUEST_URL || 'https://gabay.online'

export function polarCustomerPortalRequestUrl(
  email?: string | null
): string {
  const trimmed = email?.trim()
  if (!trimmed) return POLAR_CUSTOMER_PORTAL_REQUEST_BASE
  return `${POLAR_CUSTOMER_PORTAL_REQUEST_BASE}?email=${encodeURIComponent(trimmed)}`
}

export const ExternalLinks = {
  patreon: 'https://gabay.online',
  github: 'https://github.com/vernu/textbee',
  discord: 'mailto:support@gabay.online',
  polar: 'https://gabay.online',
  twitter: 'https://gabay.online',
  linkedin: 'https://gabay.online',
}
