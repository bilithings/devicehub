import {AsyncLocalStorage} from 'node:async_hooks'
import crypto from 'node:crypto'

export interface ObservationContext {
    traceId?: string
    requestId?: string
    socketId?: string
    sessionId?: string
    userKey?: string
    deviceSerial?: string
    operation?: string
    unit?: string
    clientIp?: string
}

type ObservationLogger = {
    debug?: (...args: any[]) => void
    info?: (...args: any[]) => void
    warn?: (...args: any[]) => void
    error?: (...args: any[]) => void
}

const contextStorage = new AsyncLocalStorage<ObservationContext>()
const OBSERVATION_ID = /^[A-Za-z0-9._:-]{1,128}$/

function safeId(value: unknown): string | undefined {
    if (typeof value !== 'string' || !OBSERVATION_ID.test(value)) {
        return undefined
    }
    return value
}

export function createObservationId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

export function userKey(user: {email?: string} | string | null | undefined): string | undefined {
    const email = typeof user === 'string' ? user : user?.email
    if (!email) {
        return undefined
    }
    const salt = process.env.OBS_USER_HASH_SALT || 'devicehub-observability'
    return `u-${crypto.createHash('sha256').update(`${salt}:${email.toLowerCase()}`).digest('hex').slice(0, 16)}`
}

export function getObservationContext(): ObservationContext {
    return contextStorage.getStore() || {}
}

export function mergeObservationContext(values: ObservationContext): ObservationContext {
    const current = contextStorage.getStore()
    if (current) {
        Object.assign(current, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)))
        return current
    }
    return values
}

export function runWithObservation<T>(values: ObservationContext, callback: () => T): T {
    return contextStorage.run({
        ...getObservationContext(),
        ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
    }, callback)
}

export function formatObservationContext(context: ObservationContext = getObservationContext()): string {
    const fields: Array<[string, string | undefined]> = [
        ['trace', context.traceId],
        ['request', context.requestId],
        ['socket', context.socketId],
        ['session', context.sessionId],
        ['user', context.userKey],
        ['device', context.deviceSerial],
        ['op', context.operation]
    ]
    const rendered = fields
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}=${value}`)
        .join(' ')
    return rendered ? ` [${rendered}]` : ''
}

function requestHeader(req: any, name: string): string | undefined {
    const value = req?.headers?.[name]
    return Array.isArray(value) ? value[0] : safeId(value)
}

function requestDeviceSerial(req: any): string | undefined {
    const serial = req?.params?.serial || req?.body?.serial || req?.query?.serial
    return typeof serial === 'string' && serial.length <= 256 ? serial : undefined
}

export function requestObservationMiddleware(unit: string, log: ObservationLogger) {
    return function(req: any, res: any, next: any) {
        const requestId = requestHeader(req, 'x-request-id') || createObservationId('req')
        const traceId = requestHeader(req, 'x-trace-id') || requestId
        const sessionId = requestHeader(req, 'x-session-id')
        const context: ObservationContext = {
            unit,
            requestId,
            traceId,
            sessionId,
            clientIp: req.ip
        }
        res.setHeader('X-Request-ID', requestId)
        const startedAt = Date.now()
        res.once('finish', () => {
            const requestPath = req.originalUrl || req.url || ''
            if (requestPath.startsWith('/health/') && res.statusCode < 400) {
                return
            }
            const finalContext = {
                ...context,
                deviceSerial: context.deviceSerial || requestDeviceSerial(req),
                operation: context.operation || `${String(req.method).toLowerCase()} ${req.route?.path || req.path}`
            }
            runWithObservation(finalContext, () => {
                const durationMs = Date.now() - startedAt
                const writer = (res.statusCode >= 500 ? log.error : res.statusCode >= 400 ? log.warn : log.info)?.bind(log)
                writer?.('http.request status=%d durationMs=%d method=%s path=%s', res.statusCode, durationMs, req.method, req.originalUrl || req.url)
            })
        })
        runWithObservation(context, next)
    }
}

export function socketObservationMiddleware(unit: string) {
    return function(socket: any, next: any) {
        const requestId = safeId(socket.handshake?.auth?.requestId) || requestHeader(socket.handshake, 'x-request-id') || createObservationId('req')
        const traceId = safeId(socket.handshake?.auth?.traceId) || requestHeader(socket.handshake, 'x-trace-id') || requestId
        const sessionId = safeId(socket.handshake?.auth?.sessionId) || requestHeader(socket.handshake, 'x-session-id') || createObservationId('session')
        const context: ObservationContext = {
            unit,
            requestId,
            traceId,
            socketId: socket.id,
            sessionId,
            clientIp: socket.handshake.address
        }
        socket.data = socket.data || {}
        socket.data.observation = context
        runWithObservation(context, () => next())
    }
}

export function updateSocketObservation(socket: any, values: ObservationContext): ObservationContext {
    socket.data = socket.data || {}
    socket.data.observation = {
        ...(socket.data.observation || {}),
        ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
    }
    return socket.data.observation
}

export function runWithSocketObservation<T>(socket: any, callback: () => T): T {
    return runWithObservation(socket?.data?.observation || {}, callback)
}
