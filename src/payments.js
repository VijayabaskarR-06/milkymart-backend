import { createHmac, timingSafeEqual } from 'node:crypto'
import { pool, query, one } from './db.js'
import { log } from './logger.js'

// Razorpay is credential-gated like SMS. Without keys, wallet top-ups credit
// instantly (demo). With keys, the app must complete a real Razorpay payment and
// the server credits the wallet only after verifying the signature.
const KEY_ID = process.env.RAZORPAY_KEY_ID
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET
export const isLivePayments = Boolean(KEY_ID && KEY_SECRET)
export const publicKeyId = KEY_ID || null

const authHeader = () => 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')

/** Creates a Razorpay order for a wallet top-up and records it as pending. */
export async function createTopupOrder(userId, amountRupees) {
  const amountPaise = Math.round(amountRupees * 100)
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      notes: { userId: String(userId), purpose: 'wallet_topup' },
    }),
  })
  if (!res.ok) throw new Error(`Razorpay order failed (${res.status})`)
  const order = await res.json()
  await query(
    `INSERT INTO payments (user_id, provider_order_id, amount, status) VALUES ($1,$2,$3,'created')`,
    [userId, order.id, amountRupees],
  )
  log.info('payment.created', { userId, orderId: order.id, amount: amountRupees })
  return { orderId: order.id, amount: amountPaise, currency: 'INR', keyId: KEY_ID }
}

const signatureMatches = (payload, signature) => {
  const expected = createHmac('sha256', KEY_SECRET).update(payload).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(signature || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Verifies a completed checkout and credits the wallet exactly once.
 * Idempotent: replaying the same payment id will not double-credit.
 */
export async function confirmTopup(userId, { razorpay_order_id, razorpay_payment_id, razorpay_signature, trusted = false }) {
  // `trusted` is only set by the webhook handler, which has already verified the
  // payload against the webhook secret.
  if (!trusted && !signatureMatches(`${razorpay_order_id}|${razorpay_payment_id}`, razorpay_signature)) {
    log.warn('payment.bad_signature', { userId, orderId: razorpay_order_id })
    return { ok: false, error: 'Payment verification failed' }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE provider_order_id=$1 AND user_id=$2 FOR UPDATE`,
      [razorpay_order_id, userId],
    )
    const payment = rows[0]
    if (!payment) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'Unknown payment' }
    }
    if (payment.status === 'paid') {
      await client.query('COMMIT')
      const current = await one('SELECT wallet_balance FROM users WHERE id=$1', [userId])
      return { ok: true, balance: Number(current.wallet_balance), alreadyCredited: true }
    }

    const amount = Number(payment.amount)
    await client.query(
      `UPDATE payments SET status='paid', provider_payment_id=$1, paid_at=now() WHERE id=$2`,
      [razorpay_payment_id, payment.id],
    )
    const { rows: u } = await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2 RETURNING wallet_balance',
      [amount, userId],
    )
    await client.query(
      `INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,'Wallet top-up',$2,'credit')`,
      [userId, amount],
    )
    await client.query('COMMIT')
    log.info('payment.captured', { userId, paymentId: razorpay_payment_id, amount })
    return { ok: true, balance: Number(u[0].wallet_balance) }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Verifies a Razorpay webhook signature (uses the webhook secret, not the key secret). */
export function webhookIsAuthentic(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(signature || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}
