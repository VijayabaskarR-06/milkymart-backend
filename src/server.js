import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import appRoutes from './routes.app.js'
import adminRoutes from './routes.admin.js'
import { pool } from './db.js'
import { seedDatabase } from './migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(cors()) // Public API — the mobile app ships as a native origin.
app.use(express.json({ limit: '256kb' }))

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
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server' })
})

const port = process.env.PORT || 4000

// Create tables and seed the demo data on first boot, so a fresh cloud deploy is
// immediately usable with no manual migration step.
seedDatabase()
  .then(({ seeded }) => console.log(seeded ? 'Database seeded.' : 'Database ready.'))
  .catch((err) => console.error('Startup migration failed:', err))
  .finally(() => {
    app.listen(port, () => console.log(`Milky Mart API listening on :${port}`))
  })
