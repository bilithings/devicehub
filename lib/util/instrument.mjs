import * as Sentry from '@sentry/node'
import {getObservationContext} from './observability-bootstrap.mjs'

const DSN = process.env.SENTRY_DSN
const SAMPLE_RATE = Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0
const ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || 'unset'

Sentry.init({
    dsn: DSN,
    environment: ENVIRONMENT,
    // Tracing
    // Add Tracing by setting tracesSampleRate
    // We recommend adjusting this value in production
    tracesSampleRate: SAMPLE_RATE,
    integrations: [
        Sentry.mongoIntegration({
            enhancedDatabaseReporting: true
        })
    ]
})

Sentry.addEventProcessor((event) => {
    const context = getObservationContext()
    const tags = Object.fromEntries(Object.entries({
        traceId: context.traceId,
        requestId: context.requestId,
        socketId: context.socketId,
        sessionId: context.sessionId,
        userKey: context.userKey,
        deviceSerial: context.deviceSerial,
        operation: context.operation,
        unit: context.unit
    }).filter(([, value]) => value !== undefined))
    if (Object.keys(tags).length) {
        event.tags = {...event.tags, ...tags}
    }
    return event
})
console.log(`Initialized sentry for environment: ${ENVIRONMENT}`)
if (SAMPLE_RATE === 0) {
    console.warn('Warning: Sentry sample_rate is 0')
}
