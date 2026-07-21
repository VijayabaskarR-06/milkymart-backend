import { log } from './logger.js'

// Error monitoring is optional: set SENTRY_DSN and crashes/500s get reported
// with request context. Without it this is a no-op.
let Sentry = null

export const monitoringEnabled = Boolean(process.env.SENTRY_DSN)

export async function initMonitoring() {
  if (!monitoringEnabled) return null
  try {
    Sentry = await import('@sentry/node')
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.RENDER_GIT_COMMIT || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE || 0),
      // Never ship customer phone numbers or tokens to a third party.
      beforeSend(event) {
        if (event.request?.headers) {
          delete event.request.headers.authorization
          delete event.request.headers.cookie
        }
        return event
      },
    })
    log.info('monitoring.enabled', { environment: process.env.NODE_ENV })
    return Sentry
  } catch (err) {
    log.error('monitoring.init_failed', { error: err.message })
    return null
  }
}

export function captureError(err, context = {}) {
  if (!Sentry) return
  try {
    Sentry.withScope((scope) => {
      Object.entries(context).forEach(([k, v]) => scope.setTag(k, String(v)))
      Sentry.captureException(err)
    })
  } catch {
    // monitoring must never break a request
  }
}
