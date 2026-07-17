import pg from 'pg'

// Managed hosts (Render, Neon, Supabase, Heroku…) provide a single DATABASE_URL
// and require TLS. Locally we connect to the dev instance on port 5433 with no
// SSL. PGSSL=disable can force SSL off if a host ever needs it.
const url = process.env.DATABASE_URL
const isLocal = !url || /localhost|127\.0\.0\.1|\/tmp/.test(url)
const useSsl = process.env.PGSSL !== 'disable' && !isLocal

export const pool = new pg.Pool(
  url
    ? { connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false }
    : { host: '/tmp', port: 5433, user: 'postgres', database: 'milkymart' },
)

export const query = (text, params) => pool.query(text, params)

// Small helper for single-row reads.
export const one = async (text, params) => {
  const { rows } = await pool.query(text, params)
  return rows[0] || null
}
