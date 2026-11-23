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
  Req,
  Res,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import type { Request as ExpressRequest, Response } from 'express'
import mongoose from 'mongoose'
import { AuthGuard } from '../../auth/guards/auth.guard'
import { CanModifyDevice } from '../guards/can-modify-device.guard'
import {
  parseRemoteCameraCommand,
  parseRemoteScreenFrame,
  parseRemoteScreenStatus,
} from './remote-screen.dto'
import { REMOTE_SCREEN_MAX_WAIT_MS } from './remote-screen.service'
import { RemoteCameraService } from './remote-camera.service'

function toNumber(value: string | undefined) {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Live camera view of a phone (e.g. a server-room security camera). Same
 * guards and phone protocol as the remote screen; the viewer watches through
 * the MJPEG stream below or by polling.
 */
@ApiTags('gateway')
@ApiBearerAuth()
@Controller('gateway/devices/:id/remote-camera')
@UseGuards(AuthGuard, CanModifyDevice)
// A live view is a few requests per second from the phone and the viewer,
// often behind the same school NAT; the global 500/min would cut it off.
@Throttle({ default: { limit: 3000, ttl: 60000 } })
export class RemoteCameraController {
  constructor(private readonly remoteScreen: RemoteCameraService) {}

  private requireDashboardLogin(req: { apiKey?: unknown }) {
    if (req.apiKey)
      throw new ForbiddenException(
        'The camera view requires a dashboard login, not an API key',
      )
  }

  private viewerId(req: { user?: { _id?: unknown; id?: unknown } }) {
    return String(req.user?._id ?? req.user?.id ?? '')
  }

  @ApiOperation({ summary: 'Start viewing the phone camera (wakes the phone)' })
  @Post('/session')
  async start(@Param('id') deviceId: string, @Request() req) {
    this.requireDashboardLogin(req)
    const data = await this.remoteScreen.start(deviceId, this.viewerId(req))
    return { data }
  }

  @ApiOperation({ summary: 'Stop viewing the phone camera' })
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

  @ApiOperation({ summary: 'Switch camera or rotate the picture' })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('/input')
  async input(@Param('id') deviceId: string, @Body() body: unknown, @Request() req) {
    this.requireDashboardLogin(req)
    const command = parseRemoteCameraCommand(body)
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

/**
 * MJPEG stream for the camera viewer. An <img> cannot send the dashboard's
 * login header, so this route is authorised by the short-lived stream token
 * that only a logged-in owner receives from POST /session.
 */
@ApiTags('gateway')
@Controller('gateway/devices/:id/remote-camera')
@Throttle({ default: { limit: 300, ttl: 60000 } })
export class RemoteCameraStreamController {
  constructor(private readonly remoteCamera: RemoteCameraService) {}

  @ApiOperation({ summary: 'MJPEG live stream (token from POST /session)' })
  @Get('/stream')
  async stream(
    @Param('id') deviceId: string,
    @Query('token') token: string | undefined,
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    if (!mongoose.Types.ObjectId.isValid(deviceId) || typeof token !== 'string')
      throw new ForbiddenException('Invalid or expired stream')
    let closed = false
    // Watch the response: on Node 16+ req 'close' fires once a GET is read.
    res.on('close', () => (closed = true))
    let started = false
    const boundary = 'gabayframe'
    try {
      await this.remoteCamera.streamFrames(
        deviceId,
        token,
        async (jpeg) => {
          if (!started) {
            started = true
            res.status(200)
            res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${boundary}`)
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
            res.setHeader('Pragma', 'no-cache')
            // Stop reverse proxies (nginx) from buffering the stream.
            res.setHeader('X-Accel-Buffering', 'no')
            res.flushHeaders()
          }
          res.write(
            `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
          )
          res.write(jpeg)
          const drained = res.write('\r\n')
          // Slow viewer: wait for the socket instead of piling frames in memory.
          if (!drained && !closed)
            await new Promise<void>((resolve) => {
              res.once('drain', resolve)
              res.once('close', resolve)
            })
        },
        () => closed || res.writableEnded,
      )
    } catch (error) {
      if (!started) throw error
    }
    if (!started && !res.headersSent) {
      res.status(204).end()
      return
    }
    if (!res.writableEnded) res.end()
  }
}
