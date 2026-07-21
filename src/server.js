import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import appRoutes from './routes.app.js'
import adminRoutes from './routes.admin.js'
import { pool } from './db.js'
import { seedDatabase } from './migrate.js'
import { runMigrations } from './migrator.js'
import { log, requestLogger } from './logger.js'
import { webhookIsAuthentic, confirmTopup } from './payments.js'
import { initMonitoring, captureError } from './monitoring.js'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()
app.set('trust proxy', 1) // behind Render's proxy — needed for correct client IPs
app.use(requestLogger)

// Security headers. CSP is relaxed only for the self-hosted admin page's inline
// styles/handlers; the JSON API sends no HTML so it is unaffected.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
)

// CORS: the native mobile app sends no Origin (allowed); browser callers must be
// in CORS_ORIGINS (comma-separated) when that is set, else all origins are allowed.
const allowOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowOrigins.length === 0 || allowOrigins.includes(origin)) return cb(null, true)
      cb(new Error('Not allowed by CORS'))
    },
  }),
)

// Razorpay webhook needs the raw body to verify its signature, so it is mounted
// before the JSON parser. It is a safety net: the app's confirm call normally
// credits the wallet first, and crediting is idempotent either way.
app.post('/api/webhooks/razorpay', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature']
  if (!webhookIsAuthentic(req.body, signature)) {
    log.warn('webhook.rejected', { provider: 'razorpay' })
    return res.status(400).json({ error: 'Invalid signature' })
  }
  try {
    const event = JSON.parse(req.body.toString('utf8'))
    const entity = event?.payload?.payment?.entity
    if (event?.event === 'payment.captured' && entity?.order_id) {
      const userId = Number(entity?.notes?.userId)
      if (userId) {
        await confirmTopup(userId, {
          razorpay_order_id: entity.order_id,
          razorpay_payment_id: entity.id,
          razorpay_signature: null,
          trusted: true,
        })
      }
    }
    log.info('webhook.received', { event: event?.event })
    res.json({ ok: true })
  } catch (err) {
    log.error('webhook.failed', { error: err.message })
    res.status(200).json({ ok: true }) // ack anyway so Razorpay stops retrying
  }
})

app.use(express.json({ limit: '256kb' }))

// Throttle auth + admin-login endpoints against brute force (production only, so
// local dev and the test suite aren't rate-limited).
if (process.env.NODE_ENV === 'production') {
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false })
  app.use('/api/auth', authLimiter)
  app.use('/api/admin/login', authLimiter)
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', time: new Date().toISOString() })
  } catch {
    res.status(503).json({ status: 'db-unavailable' })
  }
})

app.use('/api', appRoutes)
app.use('/api/admin', adminRoutes)

// Serve the admin dashboard as a static site at /admin.
app.use('/admin', express.static(join(here, '..', 'public', 'admin')))

// Public privacy policy and terms — required for the Play Store listing and
// linked from the app's Terms & privacy screen.
app.use('/legal', express.static(join(here, '..', 'public', 'legal')))
app.get('/privacy', (_req, res) => res.redirect('/legal/privacy.html'))
app.get('/terms', (_req, res) => res.redirect('/legal/terms.html'))

app.get('/', (_req, res) => {
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Milky Mart API</title>
     <body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;color:#0f172a">
     <h1>🥛 Milky Mart API</h1>
     <p>The backend is running.</p>
     <ul>
       <li><a href="/admin/">Admin dashboard →</a></li>
       <li><a href="/health">Health check →</a></li>
       <li><code>/api/*</code> — mobile app endpoints</li>
       <li><code>/api/admin/*</code> — admin endpoints</li>
     </ul></body>`,
  )
})

// Central error handler so a thrown route never crashes the process.
app.use((err, req, res, _next) => {
  log.error('unhandled', { error: err.message, stack: err.stack?.split('\n')[1]?.trim(), path: req.originalUrl })
  captureError(err, { path: req.originalUrl, method: req.method })
  res.status(500).json({ error: 'Something went wrong on the server' })
})

// Never let an unexpected rejection take the process down silently.
process.on('unhandledRejection', (reason) => { log.error('unhandledRejection', { reason: String(reason) }); captureError(reason instanceof Error ? reason : new Error(String(reason))) })
process.on('uncaughtException', (err) => log.error('uncaughtException', { error: err.message }))

const port = process.env.PORT || 4000

// Apply pending migrations, then seed demo data on a fresh database, so a new
// cloud deploy comes up ready with no manual step.
initMonitoring()
  .then(() => runMigrations())
  .then(({ ran, total }) => log.info('migrations.done', { applied: ran, total }))
  .then(() => seedDatabase())
  .then(({ seeded }) => log.info(seeded ? 'db.seeded' : 'db.ready'))
  .catch((err) => log.error('startup.failed', { error: err.message }))
  .finally(() => {
    app.listen(port, () => log.info('server.listening', { port }))
  })
