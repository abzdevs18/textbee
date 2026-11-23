import {
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
import { AuthGuard } from '../../auth/guards/auth.guard'
import { CanModifyDevice } from '../guards/can-modify-device.guard'
import {
  parseRemoteScreenCommand,
  parseRemoteScreenFrame,
  parseRemoteScreenStatus,
} from './remote-screen.dto'
import { RemoteScreenService } from './remote-screen.service'

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
    @Request() req,
  ) {
    this.requireDashboardLogin(req)
    const sinceNumber = since ? Number(since) : undefined
    const data = await this.remoteScreen.view(
      deviceId,
      Number.isFinite(sinceNumber) ? sinceNumber : undefined,
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
