const SESSION_STORAGE_KEY = 'devicehub-observation-session-id'

const randomId = (prefix: string): string => {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `${prefix}-${uuid.slice(0, 20)}`
}

export const getObservationSessionId = (): string => {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (existing) return existing
    const created = randomId('session')
    sessionStorage.setItem(SESSION_STORAGE_KEY, created)
    return created
  } catch {
    return randomId('session')
  }
}

export const getRequestObservation = () => ({
  requestId: randomId('req'),
  traceId: randomId('trace'),
  sessionId: getObservationSessionId(),
})
