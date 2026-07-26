import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Logger } from '@nestjs/common'
import { UsersService } from '../../users/users.service'
import { AuthService } from '../auth.service'
import * as bcrypt from 'bcryptjs'

@Injectable()
// Guard for authenticating users by either jwt token or api key
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name)

  constructor(
    private jwtService: JwtService,
    private usersService: UsersService,
    private authService: AuthService,
  ) {}

  /** Never log a usable credential — only enough to identify the record. */
  private maskKey(apiKeyString: string): string {
    if (typeof apiKeyString !== 'string' || apiKeyString.length < 8) {
      return 'invalid'
    }
    return `${apiKeyString.substring(0, 8)}...`
  }

  private reject(reason: string, request: any, apiKeyString?: string): never {
    // Guard rejections used to be completely silent, which made expired or
    // revoked device keys undiagnosable from the API logs.
    this.logger.warn(
      `Auth rejected (${reason}) ${request.method} ${request.originalUrl || request.url}` +
        (apiKeyString ? ` apiKey=${this.maskKey(apiKeyString)}` : ''),
    )
    throw new HttpException(
      {
        error: 'Unauthorized',
        reason,
      },
      HttpStatus.UNAUTHORIZED,
    )
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    let userId
    const apiKeyString = request.headers['x-api-key'] || request.query.apiKey
    if (request.headers.authorization?.startsWith('Bearer ')) {
      const bearerToken = request.headers.authorization.split(' ')[1]
      try {
        const payload = this.jwtService.verify(bearerToken)
        userId = payload.sub
      } catch (e) {
        this.reject('invalid_bearer_token', request)
      }
    } else if (apiKeyString) {
      const apiKey =
        await this.authService.findActiveApiKeyByClientKey(apiKeyString)

      if (!apiKey) {
        // No active record: either the key never existed or it was revoked.
        this.reject('api_key_not_found_or_revoked', request, apiKeyString)
      }

      if (!apiKey.hashedApiKey) {
        this.reject('api_key_record_missing_hash', request, apiKeyString)
      }

      if (!bcrypt.compareSync(apiKeyString, apiKey.hashedApiKey)) {
        this.reject('api_key_hash_mismatch', request, apiKeyString)
      }

      userId = apiKey.user
      request.apiKey = apiKey
    } else {
      this.reject('missing_credentials', request)
    }

    if (userId) {
      const user = await this.usersService.findOne({ _id: userId })
      if (user) {
        request.user = user
        this.authService.trackAccessLog({ request })
        return true
      }
      this.reject('user_not_found', request, apiKeyString)
    }

    this.reject('unauthenticated', request, apiKeyString)
  }
}
