import { makeAutoObservable } from 'mobx'
import { inject, injectable } from 'inversify'

import { GroupService } from '@/services/group-service'
import { releaseUserDevice } from '@/api/openstf-api'

import { CONTAINER_IDS } from '@/config/inversify/container-ids'

@injectable()
export class DeviceDisconnection {
  constructor(@inject(CONTAINER_IDS.groupService) private groupService: GroupService) {
    makeAutoObservable(this)
  }

  async stopUsingDevice(serial: string, channel: string, force = false): Promise<unknown> {
    if (force) {
      return releaseUserDevice(serial)
    }

    return this.groupService.kick(serial, channel)
  }
}
