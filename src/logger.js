import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

// Per-request context so every log line can carry the request id without
// threading it through every function.
const store = new AsyncLocalStorage()

const write = (level, message, fields = {}) => {
  const ctx = store.getStore()
  const line = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...fields,
  }
  const out = JSON.stringify(line)
  if (level === 'error') console.error(out)
  else console.log(out)
}

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
}

// Tags each request with an id, echoes it back, and logs method/path/status/duration.
export function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] || randomUUID()
  res.setHeader('X-Request-Id', requestId)
  const started = Date.now()
  store.run({ requestId }, () => {
    res.on('finish', () => {
      // Health checks are noisy and uninteresting.
      if (req.path === '/health') return
      const fields = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Date.now() - started,
      }
      if (res.statusCode >= 500) log.error('request', fields)
      else if (res.statusCode >= 400) log.warn('request', fields)
      else log.info('request', fields)
    })
    next()
  })
}
