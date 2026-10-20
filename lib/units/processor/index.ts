import Promise from 'bluebird'
import logger from '../../util/logger.js'
import wire from '../../wire/index.js'
import {WireRouter} from '../../wire/router.js'
import wireutil from '../../wire/util.js'
import db from '../../db/index.js'
import dbapi from '../../db/models/all/index.js'
import lifecycle from '../../util/lifecycle.js'
import srv from '../../util/srv.js'
import * as zmqutil from '../../util/zmqutil.js'
import UserModel from '../../db/models/user/index.js'
import DeviceModel from '../../db/models/device/index.js'
import {
    UserChangeMessage,
    GroupChangeMessage,
    DeviceGroupChangeMessage,
    GroupUserChangeMessage,
    DeviceHeartbeatMessage,
    DeviceLogMessage,
    TransactionProgressMessage,
    TransactionDoneMessage,
    TransactionTreeMessage,
    InstallResultMessage,
    DeviceLogcatEntryMessage,
    TemporarilyUnavailableMessage,
    UpdateRemoteConnectUrl,
    InstalledApplications,
    DeviceIntroductionMessage,
    InitializeIosDeviceState,
    DevicePresentMessage,
    DeviceAbsentMessage,
    DeviceStatusMessage,
    DeviceReadyMessage,
    JoinGroupByAdbFingerprintMessage,
    JoinGroupByVncAuthResponseMessage,
    ConnectStartedMessage,
    ConnectStoppedMessage,
    JoinGroupMessage,
    LeaveGroupMessage,
    DeviceIdentityMessage,
    AirplaneModeEvent,
    BatteryEvent,
    DeviceBrowserMessage,
    ConnectivityEvent,
    PhoneStateEvent,
    RotationEvent,
    CapabilitiesMessage,
    ReverseForwardsEvent,
    UpdateIosDevice,
    SdkIosVersion,
    SizeIosDevice,
    DeviceTypeMessage,
    DeleteDevice,
    GetServicesAvailabilityMessage,
    DeviceStatus,
    DeviceRegisteredMessage, GetPresentDevices, DeviceGetIsInOrigin, GetDeadDevices, DeviceIosIntroductionMessage
} from '../../wire/wire.js'

interface Options {
    name: string
    endpoints: {
        appDealer: string[]
        devDealer: string[]
    }
    publicIp: string
    offlineReleaseDelayMs?: number
}

export default db.ensureConnectivity(async(options: Options) => {
    const log = logger.createLogger('processor')
    if (options.name) {
        logger.setGlobalIdentifier(options.name)
    }

    await db.connect()

    // App side
    const appDealer = zmqutil.socket('dealer')
    await Promise.all(options.endpoints.appDealer.map(async(endpoint: string) => {
        try {
            return await srv.resolve(endpoint).then((records) =>
                srv.attempt(records, (record) => {
                    log.info('App dealer connected to "%s"', record.url)
                    appDealer.connect(record.url)
                    return true
                })
            )
        }
        catch (err: any) {
            log.fatal('Unable to connect to app dealer endpoint %s', err?.message)
            lifecycle.fatal()
        }
    }))

    // Device side
    const devDealer = zmqutil.socket('dealer')
    appDealer.on('message', (channel, data) => {
        devDealer.send([channel, data])
    })

    const reply = wireutil.reply(wireutil.global)
    await Promise.all(options.endpoints.devDealer.map(async(endpoint: string) => {
        try {
            return await srv.resolve(endpoint).then((records) =>
                srv.attempt(records, (record) => {
                    log.info('Device dealer connected to "%s"', record.url)
                    devDealer.connect(record.url)
                    return true
                })
            )
        }
        catch (err: any) {
            log.fatal('Unable to connect to dev dealer endpoint %s', err?.message)
            lifecycle.fatal()
        }
    }))

    const configuredOfflineReleaseDelayMs = options.offlineReleaseDelayMs ??
        Number.parseInt(process.env.STF_PROCESSOR_OFFLINE_RELEASE_DELAY_MS || '30000', 10)
    const offlineReleaseDelayMs = Math.max(
        0,
        Number.isFinite(configuredOfflineReleaseDelayMs) ? configuredOfflineReleaseDelayMs : 30000
    )
    const offlineReleaseTimers = new Map<string, NodeJS.Timeout>()

    const clearOfflineReleaseTimer = (serial: string) => {
        const timer = offlineReleaseTimers.get(serial)
        if (timer) {
            clearTimeout(timer)
            offlineReleaseTimers.delete(serial)
        }
    }

    const releaseOfflineDevice = async(serial: string) => {
        offlineReleaseTimers.delete(serial)

        const device = await DeviceModel.loadDeviceBySerial(serial)
        if (!device || ![DeviceStatus.OFFLINE, DeviceStatus.UNAUTHORIZED].includes(device.status) || !device.owner) {
            return
        }

        const owner = device.owner
        const ownerMessage = {
            email: owner.email,
            name: owner.name || owner.email,
            group: owner.group
        }

        await Promise.all([
            dbapi.setDeviceState(serial, {owner: null, usage: null, timeout: 0}),
            dbapi.unsetDeviceConnectUrl(serial),
            dbapi.sendEvent(
                'device_leave',
                {reason: 'offline_timeout'},
                {deviceSerial: serial, userEmail: owner.email, groupId: owner.group},
                Date.now()
            )
        ])

        log.warn(
            'Automatically released device "%s" after %s ms of offline/unauthorized state (owner=%s)',
            serial,
            offlineReleaseDelayMs,
            owner.email
        )

        appDealer.send([
            wireutil.global,
            wireutil.pack(LeaveGroupMessage, {
                serial,
                owner: ownerMessage,
                reason: 'status_change'
            })
        ])
    }

    const scheduleOfflineRelease = (serial: string) => {
        if (offlineReleaseTimers.has(serial)) return

        offlineReleaseTimers.set(serial, setTimeout(() => {
            releaseOfflineDevice(serial).catch(err => {
                offlineReleaseTimers.delete(serial)
                log.error('Failed to automatically release offline device "%s": %s', serial, err?.message || err)
                scheduleOfflineRelease(serial)
            })
        }, offlineReleaseDelayMs))
    }

    const defaultWireHandler =
        (channel: string, _: any, data: any) =>
            appDealer.send([channel, data])

    const router = new WireRouter()
        .on(UserChangeMessage, defaultWireHandler)
        .on(GroupChangeMessage, defaultWireHandler)
        .on(DeviceGroupChangeMessage, defaultWireHandler)
        .on(GroupUserChangeMessage, defaultWireHandler)
        .on(DeviceLogMessage, defaultWireHandler)
        .on(TransactionProgressMessage, defaultWireHandler)
        .on(TransactionDoneMessage, defaultWireHandler)
        .on(TransactionTreeMessage, defaultWireHandler)
        .on(InstallResultMessage, defaultWireHandler)
        .on(DeviceLogcatEntryMessage, defaultWireHandler)
        .on(TemporarilyUnavailableMessage, defaultWireHandler)
        .on(UpdateRemoteConnectUrl, defaultWireHandler)
        .on(InstalledApplications, defaultWireHandler)
        .on(DeviceIntroductionMessage, async (channel, message, data) => {
            await dbapi.saveDeviceInitialState(message.serial, message)
            devDealer.send([
                message.provider!.channel,
                wireutil.pack(DeviceRegisteredMessage, {serial: message.serial})
            ])
            appDealer.send([channel, data])
        })
        .on(DeviceIosIntroductionMessage, async(channel, message, data) => {
            await dbapi.saveIosDeviceInitialState(options.publicIp, message)
            devDealer.send([
                message.provider!.channel,
                wireutil.pack(DeviceRegisteredMessage, {serial: message.serial})
            ])
        })
        .on(InitializeIosDeviceState, (channel, message, data) => {
            dbapi.initializeIosDeviceState(options.publicIp, message)
        })
        .on(DevicePresentMessage, async (channel, message, data) => {
            await dbapi.setDevicePresent(message.serial)
            appDealer.send([channel, data])
        })
        .on(DeviceAbsentMessage, async (channel, message, data) => {
            clearOfflineReleaseTimer(message.serial)
            await dbapi.setDeviceAbsent(message.serial)
            appDealer.send([channel, data])
        })
        .on(DeviceStatusMessage, async (channel, message, data) => {
            await dbapi.saveDeviceStatus(message.serial, message.status)

            if ([DeviceStatus.OFFLINE, DeviceStatus.UNAUTHORIZED].includes(message.status)) {
                scheduleOfflineRelease(message.serial)
            }
            else {
                clearOfflineReleaseTimer(message.serial)
            }

            appDealer.send([channel, data])
        })
        .on(DeviceReadyMessage, async (channel, message, data) => {
            await dbapi.setDeviceReady(message.serial, message.channel)
            devDealer.send([message.channel, wireutil.envelope(new wire.ProbeMessage())])
            appDealer.send([channel, data])
        })
        .on(JoinGroupByAdbFingerprintMessage, async (channel, message) => {
            try {
                const user = await UserModel.lookupUserByAdbFingerprint(message.fingerprint)
                if (user) {
                    devDealer.send([
                        channel,
                        wireutil.envelope(new wire.AutoGroupMessage(new wire.OwnerMessage(user.email, user.name, user.group), message.fingerprint))
                    ])
                    return
                }
                appDealer.send([
                    message.currentGroup,
                    wireutil.envelope(new wire.JoinGroupByAdbFingerprintMessage(message.serial, message.fingerprint, message.comment))
                ])
            } catch (err: any) {
                log.error('Unable to lookup user by ADB fingerprint "%s": %s', message.fingerprint, err?.message)
            }
        })
        .on(JoinGroupByVncAuthResponseMessage, async (channel, message) => {
            try {
                const user = await dbapi.lookupUserByVncAuthResponse(message.response, message.serial)
                if (user) {
                    devDealer.send([
                        channel,
                        wireutil.envelope(new wire.AutoGroupMessage(new wire.OwnerMessage(user.email, user.name, user.group), message.response))
                    ])
                    return
                }

                appDealer.send([
                    message.currentGroup,
                    wireutil.envelope(new wire.JoinGroupByVncAuthResponseMessage(message.serial, message.response))
                ])
            } catch (err: any) {
                log.error('Unable to lookup user by VNC auth response "%s": %s', message.response, err?.message)
            }
        })
        .on(ConnectStartedMessage, async (channel, message, data) => {
            await dbapi.setDeviceConnectUrl(message.serial, message.url)
            appDealer.send([channel, data])
        })
        .on(ConnectStoppedMessage, async (channel, message, data) => {
            await dbapi.unsetDeviceConnectUrl(message.serial)
            appDealer.send([channel, data])
        })
        .on(JoinGroupMessage, async (channel, message, data) => {
            await Promise.all([ // @ts-ignore
                dbapi.setDeviceState(message.serial, message),
                dbapi.sendEvent(`device_${message.usage || 'use'}`
                    , {}
                    , {deviceSerial: message.serial, userEmail: message.owner!.email, groupId: message.owner!.group}
                    , Date.now()
                )
            ])
            appDealer.send([channel, data])
        })
        .on(LeaveGroupMessage, async (channel, message, data) => {
            await Promise.all([
                dbapi.setDeviceState(message.serial, {owner: null, usage: null, timeout: 0}),
                dbapi.sendEvent('device_leave'
                    , {}
                    , {deviceSerial: message.serial, userEmail: message.owner!.email, groupId: message.owner!.group}
                    , Date.now()
                )
            ])
            appDealer.send([channel, data])
        })
        .on(DeviceGetIsInOrigin, async (channel, message) => {
            const device = await DeviceModel.loadDeviceBySerial(message.serial)
            const isInOrigin = device ? device.group.id === device.group.origin : false
            devDealer.send([
                channel,
                reply.okay('success', {isInOrigin})
            ])
        })
        .on(DeviceIdentityMessage, (channel, message, data) => {
            dbapi.saveDeviceIdentity(message.serial, message)
            appDealer.send([channel, data])
        })
        .on(AirplaneModeEvent, (channel, message, data) => {
            dbapi.setDeviceAirplaneMode(message.serial, message.enabled)
            appDealer.send([channel, data])
        })
        .on(BatteryEvent, (channel, message, data) => {
            dbapi.setDeviceBattery(message.serial, message)
            appDealer.send([channel, data])
        })
        .on(DeviceBrowserMessage, (channel, message, data) => {
            dbapi.setDeviceBrowser(message.serial, message)
            appDealer.send([channel, data])
        })
        .on(ConnectivityEvent, (channel, message, data) => {
            dbapi.setDeviceConnectivity(message.serial, message)
            appDealer.send([channel, data])
        })
        .on(PhoneStateEvent, (channel, message, data) => {
            dbapi.setDevicePhoneState(message.serial, message)
            appDealer.send([channel, data])
        })
        .on(RotationEvent, (channel, message, data) => {
            dbapi.setDeviceRotation(message)
            appDealer.send([channel, data])
        })
        .on(CapabilitiesMessage, (channel, message, data) => {
            dbapi.setDeviceCapabilities(message)
            appDealer.send([channel, data])
        })
        .on(ReverseForwardsEvent, (channel, message, data) => {
            dbapi.setDeviceReverseForwards(message.serial, message.forwards)
            appDealer.send([channel, data])
        })
        .on(UpdateIosDevice, (channel, message, data) =>
            dbapi.updateIosDevice(message)
        )
        .on(SdkIosVersion, (channel, message, data) => {
            dbapi.setDeviceIosVersion(message)
        })
        .on(SizeIosDevice, (channel, message, data) => {
            dbapi.sizeIosDevice(message.id, message.height, message.width, message.scale, message.url)
            appDealer.send([channel, data])
        })
        .on(DeviceTypeMessage, (channel, message, data) => {
            dbapi.setDeviceType(message.serial, message.type)
        })
        .on(GetServicesAvailabilityMessage, (channel, message, data) => {
            dbapi.setDeviceServicesAvailability(message.serial, message)
            appDealer.send([channel, data])
        })
        .on(GetPresentDevices, async (channel, message, data) => {
            const devices = await DeviceModel.loadPresentDevices()
                .then(devices => devices.map(d => d.serial))
            devDealer.send([
                channel,
                reply.okay('success', {devices})
            ])
        })
        .on(DeviceHeartbeatMessage, (channel, message, data) => {
            devDealer.send([ channel, data ])
        })
        .on(GetDeadDevices, async(channel, message, data) => {
            const deadDevices = await DeviceModel.getDeadDevice(message.time)
            devDealer.send([
                channel,
                reply.okay('success', {deadDevices})
            ])
        })
        .on(DeleteDevice, async(channel, message, data) => {
            DeviceModel.deleteDevice(message.serial)
        })
        .handler();

    devDealer.on('message', router)

    lifecycle.observe(() => {
        offlineReleaseTimers.forEach(timer => clearTimeout(timer))
        offlineReleaseTimers.clear()

        ;[appDealer, devDealer].forEach(function(sock) {
            try {
                sock.close()
            }
            catch (err: any) {
                log.error('Error while closing socket "%s"', err?.message)
            }
        })
    })
})
