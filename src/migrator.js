import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pool } from './db.js'
import { log } from './logger.js'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// Applies any migration files that haven't run yet, in filename order, each in
// its own transaction. Applied names are recorded so re-runs are no-ops.
export async function runMigrations() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    const { rows } = await client.query('SELECT name FROM schema_migrations')
    const applied = new Set(rows.map((r) => r.name))
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

    let ran = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        ran += 1
        log.info('migration.applied', { file })
      } catch (err) {
        await client.query('ROLLBACK')
        log.error('migration.failed', { file, error: err.message })
        throw err
      }
    }
    return { ran, total: files.length }
  } finally {
    client.release()
  }
}
