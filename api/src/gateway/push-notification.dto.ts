import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  validateSync,
} from 'class-validator'
import { BadRequestException } from '@nestjs/common'

/** Small, public notification text only. Never send academic payloads to lock screens. */
export class PushNotificationDTO {
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,128}$/)
  id: string

  @IsString()
  @Matches(/^[a-zA-Z0-9 ._-]{1,60}$/)
  category: string

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title: string

  @IsString()
  @MinLength(1)
  @MaxLength(320)
  body: string

  @IsIn(['issue', 'degraded', 'outage', 'recovered'])
  severity: 'issue' | 'degraded' | 'outage' | 'recovered'

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true, disallow_auth: true })
  @MaxLength(1024)
  url?: string
}

/** Validate this route explicitly; the legacy app has no global validation pipe. */
export function parsePushNotification(body: unknown): PushNotificationDTO {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Invalid push notification')
  const fields = new Set(['id', 'category', 'title', 'body', 'severity', 'url'])
  if (Object.keys(body).some((field) => !fields.has(field)))
    throw new BadRequestException('Invalid push notification')
  const input = Object.assign(new PushNotificationDTO(), body)
  if (
    validateSync(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length
  ) {
    throw new BadRequestException('Invalid push notification')
  }
  return input
}
