import { pool, query, one } from './db.js'
import { log } from './logger.js'
import { notifyUser } from './notify.js'

// A subscription delivers the same basket every day and bills only for the day
// it delivers. Money is never taken in advance, so the customer's exposure is
// one day's milk, and a plan simply stalls (rather than failing) when the wallet
// runs dry — the rider collects cash, an admin approves it, and it resumes.

/** Today in the delivery timezone (IST), as YYYY-MM-DD. */
export function deliveryToday(now = new Date()) {
  // Deliveries are Patna-local; using UTC here would roll the day over at
  // 05:30 IST, in the middle of the 06:00-08:00 delivery slot.
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

async function nextOrderId(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(substring(id from 3) AS INTEGER)), 1051) AS max FROM orders WHERE id ~ '^MM[0-9]+$'`,
  )
  return `MM${rows[0].max + 1}`
}

/**
 * Generates today's delivery for one subscription. Runs in its own transaction
 * and takes row locks on both the subscription and the user, so two concurrent
 * runners cannot both bill the same plan.
 *
 * Returns 'delivered' | 'insufficient' | 'skipped'.
 */
async function runOne(subId, today) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Re-read under lock: another runner may have handled this row already.
    // Postgres decides whether the plan is due, not JavaScript. A DATE column
    // comes back as a Date at local midnight, so formatting it via toISOString()
    // in IST yields the previous day — which would defeat this very guard and
    // bill the customer twice in one day.
    const { rows } = await client.query(
      `SELECT *, (last_run_on IS NULL OR last_run_on < $2::date) AS due
         FROM subscriptions WHERE id=$1 FOR UPDATE`,
      [subId, today],
    )
    const sub = rows[0]
    if (!sub || !['active', 'insufficient'].includes(sub.status) || !sub.due) {
      await client.query('ROLLBACK')
      return 'skipped'
    }

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [sub.user_id])
    const user = userRows[0]
    if (!user) { await client.query('ROLLBACK'); return 'skipped' }

    // Re-price from live products every day, so a price change or a product
    // going inactive is reflected rather than billed at yesterday's rate.
    let total = 0
    let itemCount = 0
    const labels = []
    for (const line of sub.items) {
      const product = await one('SELECT * FROM products WHERE id=$1 AND active=true', [line.id])
      if (!product) continue
      const qty = Math.max(1, Math.min(99, Math.floor(Number(line.quantity) || 0)))
      total += Number(product.price) * qty
      itemCount += qty
      labels.push(`${qty} × ${product.name}`)
    }

    if (!labels.length) {
      // Every product in the plan has been withdrawn — stop rather than deliver
      // an empty order every morning.
      await client.query(`UPDATE subscriptions SET status='cancelled', cancelled_at=now() WHERE id=$1`, [subId])
      await client.query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [
        sub.user_id, 'Subscription stopped', 'The products in your daily plan are no longer available.',
      ])
      await client.query('COMMIT')
      return 'skipped'
    }

    if (Number(user.wallet_balance) < total) {
      // Not enough for today. Mark it and tell the customer — the plan is not
      // cancelled, it resumes on its own once the wallet is topped up.
      await client.query(`UPDATE subscriptions SET status='insufficient' WHERE id=$1`, [subId])
      await client.query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [
        sub.user_id,
        'Add balance to continue',
        `Your daily milk needs ₹${total}, but your wallet has ₹${Number(user.wallet_balance)}. Hand cash to your delivery partner to resume.`,
      ])
      await client.query('COMMIT')
      notifyUser(sub.user_id, { title: 'Add balance to continue', body: 'Your daily milk delivery is paused until your wallet is topped up.' }).catch(() => {})
      return 'insufficient'
    }

    const id = await nextOrderId(client)
    await client.query(
      `INSERT INTO orders (id, user_id, customer_name, phone, status, total, item_count, items, address, slot, payment, date, rider_id, subscription_id)
       VALUES ($1,$2,$3,$4,'Confirmed',$5,$6,$7,$8,$9,'Wallet',$10,$11,$12)`,
      [id, user.id, user.name, user.phone, total, itemCount, JSON.stringify(labels), sub.address, sub.slot,
       new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
       user.assigned_rider_id || null, subId],
    )
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2', [total, user.id])
    await client.query('INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,$2,$3,$4)', [user.id, `Daily delivery #${id}`, total, 'debit'])
    await client.query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [
      user.id, 'Today’s milk is on the way', `Order #${id} from your daily plan — ₹${total} paid from your wallet.`,
    ])
    await client.query(`UPDATE subscriptions SET status='active', last_run_on=$1 WHERE id=$2`, [today, subId])
    await client.query('COMMIT')
    log.info('subscription.delivered', { subscriptionId: subId, orderId: id, total })
    return 'delivered'
  } catch (err) {
    await client.query('ROLLBACK')
    log.error('subscription.run_failed', { subscriptionId: subId, error: err.message })
    return 'skipped'
  } finally {
    client.release()
  }
}

// Render's free plan has no scheduler, so the run is triggered lazily by normal
// traffic rather than by cron. This guard keeps it to one pass at a time and at
// most one pass a minute, so a burst of requests cannot stampede it.
let running = false
let lastRun = 0

export async function runDueSubscriptions({ force = false } = {}) {
  if (running) return { skipped: true }
  if (!force && Date.now() - lastRun < 60_000) return { skipped: true }
  running = true
  lastRun = Date.now()
  const today = deliveryToday()
  try {
    const { rows } = await query(
      `SELECT id FROM subscriptions
        WHERE status IN ('active','insufficient')
          AND (last_run_on IS NULL OR last_run_on < $1)
        ORDER BY id`,
      [today],
    )
    const result = { delivered: 0, insufficient: 0, skipped: 0 }
    for (const row of rows) result[await runOne(row.id, today)] += 1
    if (rows.length) log.info('subscription.run', { date: today, ...result })
    return result
  } finally {
    running = false
  }
}

/**
 * Formats a Postgres DATE without shifting it. node-postgres hands DATE back as
 * a Date at *local* midnight, so toISOString() moves it to the previous day in
 * any timezone east of UTC. Read the local parts instead.
 */
function dateOnly(value) {
  if (!value) return null
  if (typeof value === 'string') return value.slice(0, 10)
  const pad = (n) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

export function subscriptionForApp(s) {
  return {
    id: s.id,
    items: Array.isArray(s.labels) ? s.labels : [],
    dailyTotal: Number(s.daily_total),
    itemCount: s.item_count,
    address: s.address,
    slot: s.slot,
    status: s.status,
    lastRunOn: dateOnly(s.last_run_on),
    startedOn: s.created_at,
  }
}
