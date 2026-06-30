const mailPort = process.env.MAIL_PORT
  ? parseInt(process.env.MAIL_PORT, 10)
  : 587

const parseBoolean = (value?: string) => {
  if (!value) return undefined
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

const mailSecure = parseBoolean(process.env.MAIL_SECURE) ?? mailPort === 465
const hasMailAuth = !!(process.env.MAIL_USER && process.env.MAIL_PASS)

export const isBrevoConfigured = !!process.env.BREVO_API_KEY
export const isSmtpConfigured = !!(process.env.MAIL_HOST && process.env.MAIL_FROM)
export const isMailConfigured = isBrevoConfigured || isSmtpConfigured

export const mailTransportConfig = {
  host: process.env.MAIL_HOST,
  port: mailPort,
  secure: mailSecure,
  auth: hasMailAuth
    ? {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      }
    : undefined,
}
