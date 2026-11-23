import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { AuthGuard } from '../../auth/guards/auth.guard'
import { CanModifyDevice } from '../guards/can-modify-device.guard'
import {
  parseRemoteScreenCommand,
  parseRemoteScreenFrame,
  parseRemoteScreenStatus,
} from './remote-screen.dto'
import {
  REMOTE_SCREEN_MAX_WAIT_MS,
  RemoteScreenService,
} from './remote-screen.service'

function toNumber(value: string | undefined) {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Live view + remote taps for a gateway phone, so an operator can answer
 * on-screen system prompts (e.g. Android's "sending a large number of SMS"
 * confirmation) without being next to the phone.
 *
 * Viewer routes need a dashboard login (JWT). An API key — which school
 * systems hold to send SMS — must never be enough to see or control the
 * phone. Upload routes are called by the phone itself with its API key.
 */
@ApiTags('gateway')
@ApiBearerAuth()
@Controller('gateway/devices/:id/remote-screen')
@UseGuards(AuthGuard, CanModifyDevice)
// A live view is a few requests per second from the phone and the viewer,
// often behind the same school NAT; the global 500/min would cut it off.
@Throttle({ default: { limit: 3000, ttl: 60000 } })
export class RemoteScreenController {
  constructor(private readonly remoteScreen: RemoteScreenService) {}

  private requireDashboardLogin(req: { apiKey?: unknown }) {
    if (req.apiKey)
      throw new ForbiddenException(
        'Remote screen requires a dashboard login, not an API key',
      )
  }

  private viewerId(req: { user?: { _id?: unknown; id?: unknown } }) {
    return String(req.user?._id ?? req.user?.id ?? '')
  }

  @ApiOperation({ summary: 'Start viewing the phone screen (wakes the phone)' })
  @Post('/session')
  async start(@Param('id') deviceId: string, @Request() req) {
    this.requireDashboardLogin(req)
    const data = await this.remoteScreen.start(deviceId, this.viewerId(req))
    return { data }
  }

  @ApiOperation({ summary: 'Stop viewing the phone screen' })
  @Delete('/session')
  async stop(
    @Param('id') deviceId: string,
    @Query('sessionId') sessionId: string | undefined,
    @Request() req,
  ) {
    this.requireDashboardLogin(req)
    const scoped =
      typeof sessionId === 'string' && /^[a-f0-9]{32}$/.test(sessionId)
        ? sessionId
        : undefined
    return { data: await this.remoteScreen.stop(deviceId, scoped) }
  }

  @ApiOperation({ summary: 'Poll the latest screen frame (keeps the session alive)' })
  @Get('/')
  async view(
    @Param('id') deviceId: string,
    @Query('since') since: string | undefined,
    @Query('statusAt') statusAt: string | undefined,
    @Query('wait') wait: string | undefined,
    @Request() req,
  ) {
    this.requireDashboardLogin(req)
    const data = await this.remoteScreen.view(
      deviceId,
      toNumber(since),
      toNumber(statusAt),
      wait ? REMOTE_SCREEN_MAX_WAIT_MS : 0,
    )
    return { data }
  }

  @ApiOperation({ summary: 'Phone: wait for viewer taps (long-poll)' })
  @Get('/commands')
  async commands(
    @Param('id') deviceId: string,
    @Query('sessionId') sessionId: string | undefined,
    @Query('wait') wait: string | undefined,
  ) {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId))
      throw new BadRequestException('Invalid session id')
    const data = await this.remoteScreen.pollCommands(
      deviceId,
      sessionId,
      wait ? REMOTE_SCREEN_MAX_WAIT_MS : 0,
    )
    return { data }
  }

  @ApiOperation({ summary: 'Send a tap, swipe or Back/Home/Recents to the phone' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('/input')
  async input(@Param('id') deviceId: string, @Body() body: unknown, @Request() req) {
    this.requireDashboardLogin(req)
    const command = parseRemoteScreenCommand(body)
    return { data: await this.remoteScreen.queueCommand(deviceId, command) }
  }

  @ApiOperation({ summary: 'Phone: upload a frame and collect queued input' })
  @Post('/frame')
  async frame(@Param('id') deviceId: string, @Body() body: unknown) {
    const frame = parseRemoteScreenFrame(body)
    return { data: await this.remoteScreen.acceptFrame(deviceId, frame) }
  }

  @ApiOperation({ summary: 'Phone: report why it cannot stream' })
  @Post('/status')
  async status(@Param('id') deviceId: string, @Body() body: unknown) {
    const status = parseRemoteScreenStatus(body)
    return { data: await this.remoteScreen.acceptStatus(deviceId, status) }
  }
}
