import { Inject, Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { Device, DeviceDocument } from '../schemas/device.schema'
import { RemoteScreenService } from './remote-screen.service'
import { RemoteScreenStore } from './remote-screen.store'

export const REMOTE_CAMERA_STORE = Symbol('REMOTE_CAMERA_STORE')

/**
 * Live view of a phone's camera (server-room security camera). Same session,
 * relay and long-poll mechanics as the remote screen, on separate keys, woken
 * by its own push type so the two never interfere.
 */
@Injectable()
export class RemoteCameraService extends RemoteScreenService {
  protected readonly pushType = 'remote_camera'

  constructor(
    @Inject(REMOTE_CAMERA_STORE) store: RemoteScreenStore,
    @InjectModel(Device.name) devices: Model<DeviceDocument>,
  ) {
    super(store, devices)
  }
}
