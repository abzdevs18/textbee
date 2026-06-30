import { ISendMailOptions, MailerService } from '@nest-modules/mailer'
import { Injectable } from '@nestjs/common'
import axios from 'axios'
import Handlebars from 'handlebars'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { isBrevoConfigured, isMailConfigured } from './mail.config'

@Injectable()
export class MailService {
  constructor(private readonly mailerService: MailerService) {}

  private assertMailConfigured() {
    if (!isMailConfigured) {
      throw new Error(
        'Email is not configured. Set BREVO_API_KEY and MAIL_FROM, or configure SMTP with MAIL_HOST, MAIL_FROM, MAIL_USER and MAIL_PASS.',
      )
    }
  }

  private parseAddress(value?: any) {
    const fallbackEmail =
      process.env.BREVO_SENDER_EMAIL || process.env.MAIL_USER
    const fallbackName = process.env.BREVO_SENDER_NAME || 'Gabay SMS'

    if (value?.address) {
      return {
        name: value.name || fallbackName,
        email: value.address,
      }
    }

    const address = value || process.env.MAIL_FROM || fallbackEmail

    if (!address) {
      throw new Error('Email sender is not configured. Set MAIL_FROM.')
    }

    const match = address.match(/^\s*(?:"?([^"<]*)"?)?\s*<([^>]+)>\s*$/)

    if (match) {
      return {
        name: (match[1] || fallbackName).trim(),
        email: match[2].trim(),
      }
    }

    return {
      name: fallbackName,
      email: address.trim(),
    }
  }

  private parseRecipients(value: any) {
    const values = Array.isArray(value) ? value : [value]

    return values
      .filter(Boolean)
      .flatMap((recipient) =>
        recipient
          .toString()
          .split(',')
          .map((email) => email.trim())
          .filter(Boolean),
      )
      .map((email) => ({ email }))
  }

  private async sendWithBrevo({
    to,
    cc,
    subject,
    html,
    from,
  }: {
    to: any
    cc?: any
    subject?: string
    html?: string
    from?: any
  }) {
    const payload: any = {
      sender: this.parseAddress(from),
      to: this.parseRecipients(to),
      subject,
      htmlContent: html,
    }

    const ccRecipients = this.parseRecipients(cc)
    if (ccRecipients.length > 0) {
      payload.cc = ccRecipients
    }

    if (process.env.MAIL_REPLY_TO) {
      payload.replyTo = this.parseAddress(process.env.MAIL_REPLY_TO)
    }

    await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: {
        accept: 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
      },
    })
  }

  private async renderTemplate(template: any, context: any) {
    const templateName = template.toString().endsWith('.hbs')
      ? template.toString()
      : `${template}.hbs`
    const templatePath = join(__dirname, 'templates', templateName)
    const templateSource = await readFile(templatePath, 'utf8')
    return Handlebars.compile(templateSource)(context)
  }

  async sendEmail({ to, subject, html, from }) {
    this.assertMailConfigured()

    if (isBrevoConfigured) {
      try {
        await this.sendWithBrevo({ to, subject, html, from })
        return
      } catch (e) {
        console.error('Brevo mail delivery failed:', e?.message ?? e)
        throw e
      }
    }

    const sendMailOptions: ISendMailOptions = {
      to,
      subject,
      html,
    }

    if (from) {
      sendMailOptions['from'] = from
    }

    if (process.env.MAIL_REPLY_TO) {
      sendMailOptions['replyTo'] = process.env.MAIL_REPLY_TO
    }
    try {
      await this.mailerService.sendMail(sendMailOptions)
    } catch (e) {
      console.error('Mail delivery failed:', e?.message ?? e)
      throw e
    }
  }

  async sendEmailFromTemplate({ to, cc, subject, template, context, from }: ISendMailOptions) {
    this.assertMailConfigured()

    if (isBrevoConfigured) {
      const html = await this.renderTemplate(template, context)

      try {
        await this.sendWithBrevo({ to, cc, subject, html, from })
        return
      } catch (e) {
        console.error('Brevo mail delivery failed:', e?.message ?? e)
        throw e
      }
    }

    const sendMailOptions: ISendMailOptions = {
      to,
      cc,
      subject,
      template,
      context,
    }

    if (from) {
      sendMailOptions['from'] = from
    }

    if (process.env.MAIL_REPLY_TO) {
      sendMailOptions['replyTo'] = process.env.MAIL_REPLY_TO
    }

    try {
      await this.mailerService.sendMail(sendMailOptions)
    } catch (e) {
      console.error('Mail delivery failed:', e?.message ?? e)
      throw e
    }
  }
}
