import { Router } from 'express'
import { pool, query, one } from './db.js'
import { requireUser, signToken } from './auth.js'
import { checkServiceArea } from './serviceArea.js'
import { validate, schemas } from './validate.js'
import { issueOtp, verifyOtp as checkOtp, isLiveOtp } from './otp.js'
import { isLivePayments, createTopupOrder, confirmTopup } from './payments.js'
import { firebaseConfigured, verifyFirebaseIdToken } from './firebase.js'
import { notifyUser } from './notify.js'
import { log } from './logger.js'

const router = Router()
const num = (v) => Number(v)

// Shapes a DB user row into the session payload the app expects.
const publicUser = (u) => ({
  id: u.id,
  role: u.role,
  name: u.name,
  phone: `+91 ${String(u.phone).slice(-10)}`,
  wallet: num(u.wallet_balance),
  approved: u.role === 'rider' ? Boolean(u.approved) : true,
})

// Lets the app know which integrations are live so it can adapt its UI.
router.get('/config', (_req, res) => {
  res.json({
    liveOtp: isLiveOtp,
    livePayments: isLivePayments,
    firebaseAuth: firebaseConfigured,
    push: firebaseConfigured,
  })
})

// Finds or creates the account for a verified phone number and issues our token.
async function issueSession(phone, role) {
  let user = await one('SELECT * FROM users WHERE role=$1 AND phone=$2', [role, phone])
  if (!user) {
    const name = role === 'rider' ? 'Delivery Partner' : 'Milky Mart Customer'
    // New riders start unapproved (admin must approve); customers are approved.
    user = await one(
      'INSERT INTO users (role, phone, name, wallet_balance, approved) VALUES ($1,$2,$3,0,$4) RETURNING *',
      [role, phone, name, role !== 'rider'],
    )
  }
  const token = signToken({ kind: 'user', id: user.id, role: user.role, tv: user.token_version ?? 0 })
  return { token, user: publicUser(user) }
}

// Firebase Phone Auth: the app signs in with Firebase, then exchanges the
// resulting ID token for a Milky Mart session. Used when firebaseAuth is true.
router.post('/auth/firebase', async (req, res) => {
  const idToken = String(req.body?.idToken || '')
  const role = req.body?.role === 'rider' ? 'rider' : 'customer'
  if (!idToken) return res.status(400).json({ error: 'Missing sign-in token' })

  const verified = await verifyFirebaseIdToken(idToken)
  if (!verified.ok) return res.status(401).json({ error: verified.error })

  const session = await issueSession(verified.phone, role)
  log.info('auth.firebase', { role, phone: verified.phone.slice(-4) })
  res.json(session)
})

// ---- Auth --------------------------------------------------------------------
router.post('/auth/request-otp', validate(schemas.requestOtp), async (req, res, next) => {
  try {
    const result = await issueOtp(req.valid.phone)
    if (result.cooldown) {
      return res.status(429).json({ error: `Please wait ${result.cooldown}s before requesting another OTP` })
    }
    res.json({ ok: true, demo: Boolean(result.demo) })
  } catch (err) {
    log.error('otp.send_failed', { error: err.message })
    res.status(502).json({ error: "Couldn't send the OTP right now. Please try again." })
  }
})

router.post('/auth/verify-otp', validate(schemas.verifyOtp), async (req, res) => {
  const { phone, otp, role } = req.valid
  const check = await checkOtp(phone, otp)
  if (!check.ok) return res.status(401).json({ error: check.error })
  res.json(await issueSession(phone, role))
})

// Real logout: bumping token_version invalidates every token issued so far, and
// the device stops receiving push for this account.
router.post('/auth/logout', requireUser, async (req, res) => {
  const token = req.body?.deviceToken
  if (token) await query('DELETE FROM device_tokens WHERE token=$1', [token])
  await query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [req.auth.id])
  res.json({ ok: true })
})

// ---- Push notification devices -----------------------------------------------
router.post('/devices', requireUser, async (req, res) => {
  const token = String(req.body?.token || '').trim()
  const platform = String(req.body?.platform || 'android').slice(0, 20)
  if (!token) return res.status(400).json({ error: 'Missing device token' })
  // A device can move between accounts (shared phone), so the token maps to the
  // most recent user that registered it.
  await query(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1,$2,$3)
     ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, last_seen=now()`,
    [req.auth.id, token, platform],
  )
  res.json({ ok: true })
})

router.delete('/devices/:token', requireUser, async (req, res) => {
  await query('DELETE FROM device_tokens WHERE token=$1 AND user_id=$2', [req.params.token, req.auth.id])
  res.json({ ok: true })
})

router.get('/me', requireUser, async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id=$1', [req.auth.id])
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ user: publicUser(user) })
})

router.patch('/me', requireUser, validate(schemas.updateName), async (req, res) => {
  const user = await one('UPDATE users SET name=$1 WHERE id=$2 RETURNING *', [req.valid.name, req.auth.id])
  res.json({ user: publicUser(user) })
})

// ---- Products ----------------------------------------------------------------
router.get('/products', async (_req, res) => {
  const { rows } = await query(
    'SELECT * FROM products WHERE active=true ORDER BY sort_order, name',
  )
  res.json(
    rows.map((p) => ({
      id: p.id,
      name: p.name,
      size: p.size,
      price: num(p.price),
      mrp: p.mrp != null ? num(p.mrp) : null,
      image: p.image,
      badge: p.badge,
      description: p.description,
      category: p.category,
      stock: p.stock,
    })),
  )
})

// ---- Addresses ---------------------------------------------------------------
router.get('/addresses', requireUser, async (req, res) => {
  const { rows } = await query('SELECT id, label, detail FROM addresses WHERE user_id=$1 ORDER BY id', [req.auth.id])
  res.json(rows.map((r) => ({ id: String(r.id), label: r.label, detail: r.detail })))
})

router.post('/addresses', requireUser, async (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 20)
  const detail = String(req.body?.detail || '').trim().slice(0, 140)
  if (!label || !detail) return res.status(400).json({ error: 'Add both a label and a full address' })
  const area = checkServiceArea(detail)
  if (!area.ok) return res.status(422).json({ error: area.error, outOfArea: Boolean(area.outOfArea) })
  const row = await one('INSERT INTO addresses (user_id, label, detail) VALUES ($1,$2,$3) RETURNING id, label, detail', [req.auth.id, label, detail])
  res.status(201).json({ id: String(row.id), label: row.label, detail: row.detail })
})

router.put('/addresses/:id', requireUser, async (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 20)
  const detail = String(req.body?.detail || '').trim().slice(0, 140)
  if (!label || !detail) return res.status(400).json({ error: 'Add both a label and a full address' })
  const area = checkServiceArea(detail)
  if (!area.ok) return res.status(422).json({ error: area.error, outOfArea: Boolean(area.outOfArea) })
  const row = await one('UPDATE addresses SET label=$1, detail=$2 WHERE id=$3 AND user_id=$4 RETURNING id, label, detail', [label, detail, req.params.id, req.auth.id])
  if (!row) return res.status(404).json({ error: 'Address not found' })
  res.json({ id: String(row.id), label: row.label, detail: row.detail })
})

router.delete('/addresses/:id', requireUser, async (req, res) => {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM addresses WHERE user_id=$1', [req.auth.id])
  if (rows[0].n <= 1) return res.status(400).json({ error: 'Keep at least one delivery address' })
  await query('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.id])
  res.json({ ok: true })
})

// ---- Wallet & transactions ---------------------------------------------------
router.get('/wallet', requireUser, async (req, res) => {
  const user = await one('SELECT wallet_balance FROM users WHERE id=$1', [req.auth.id])
  const { rows } = await query('SELECT id, label, amount, type, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC, id DESC', [req.auth.id])
  res.json({
    balance: num(user.wallet_balance),
    transactions: rows.map((t) => ({ id: t.id, label: t.label, amount: num(t.amount), type: t.type, date: formatTxDate(t.created_at) })),
  })
})

// Demo mode credits instantly. With Razorpay keys configured the app must call
// /wallet/topup/create then /wallet/topup/confirm with the signed result.
router.post('/wallet/topup', requireUser, validate(schemas.topup), async (req, res) => {
  const { amount, note } = req.valid
  if (isLivePayments) {
    return res.status(409).json({
      error: 'Online payment required',
      requiresPayment: true,
    })
  }
  // Riders self-credit their own earnings wallet, so every adjustment must carry
  // a reason — it's the only record admin (and the customer it references) have
  // that cash actually changed hands, and stops "we paid, you never added it"
  // disputes later.
  if (req.auth.role === 'rider' && !note) {
    return res.status(400).json({ error: 'Add a reason for this adjustment' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const label = req.auth.role === 'rider' ? `Self-added: ${note}` : 'Wallet top-up'
    const { rows: u } = await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2 RETURNING wallet_balance', [amount, req.auth.id])
    await client.query('INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,$2,$3,$4)', [req.auth.id, label, amount, 'credit'])
    await client.query('COMMIT')
    if (req.auth.role === 'rider') {
      log.info('rider.wallet_self_adjustment', { rider: req.auth.id, amount, note })
    }
    res.json({ balance: num(u[0].wallet_balance) })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

router.post('/wallet/topup/create', requireUser, validate(schemas.topup), async (req, res, next) => {
  if (!isLivePayments) return res.status(400).json({ error: 'Online payments are not configured' })
  try {
    res.json(await createTopupOrder(req.auth.id, req.valid.amount))
  } catch (err) {
    next(err)
  }
})

router.post('/wallet/topup/confirm', requireUser, async (req, res, next) => {
  if (!isLivePayments) return res.status(400).json({ error: 'Online payments are not configured' })
  try {
    const result = await confirmTopup(req.auth.id, req.body || {})
    if (!result.ok) return res.status(400).json({ error: result.error })
    res.json({ balance: result.balance })
  } catch (err) {
    next(err)
  }
})

// ---- Orders (customer) -------------------------------------------------------
router.get('/orders', requireUser, async (req, res) => {
  const { rows } = await query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC', [req.auth.id])
  res.json(rows.map(orderForApp))
})

router.get('/orders/:id', requireUser, async (req, res) => {
  const row = await one('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.auth.id])
  if (!row) return res.status(404).json({ error: 'Order not found' })
  res.json(orderForApp(row))
})

router.post('/orders', requireUser, validate(schemas.placeOrder), async (req, res, next) => {
  const { items, address, slot, date, idempotencyKey } = req.valid
  const key = idempotencyKey || req.headers['idempotency-key'] || null

  // A retry or double-tap with the same key returns the original order.
  if (key) {
    const existing = await one('SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [req.auth.id, key])
    if (existing) {
      log.info('order.idempotent_replay', { orderId: existing.id })
      return res.status(200).json(orderForApp(existing))
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.auth.id])
    const user = userRows[0]

    // The delivery address must be inside the service area.
    const area = checkServiceArea(address)
    if (!area.ok) throw httpError(422, area.error)

    // Recompute the total from live product prices — never trust the client's amount.
    let total = 0
    let itemCount = 0
    const labels = []
    for (const line of items) {
      const product = await one('SELECT * FROM products WHERE id=$1 AND active=true', [line.id])
      if (!product) throw httpError(400, `Product unavailable: ${line.id}`)
      const qty = Math.max(1, Math.min(99, Math.floor(Number(line.quantity) || 0)))
      total += Number(product.price) * qty
      itemCount += qty
      labels.push(`${qty} × ${product.name}`)
    }

    // Payment is automatic: pay from the wallet when it covers the order, else
    // it becomes Cash on Delivery. The client's requested method is ignored.
    const payment = Number(user.wallet_balance) >= total ? 'Wallet' : 'Cash on delivery'
    // Route to the customer's permanent delivery partner, if the admin set one.
    const riderId = user.assigned_rider_id || null

    const id = await nextOrderId(client)
    const inserted = await client.query(
      `INSERT INTO orders (id, user_id, customer_name, phone, status, total, item_count, items, address, slot, payment, date, rider_id, idempotency_key)
       VALUES ($1,$2,$3,$4,'Confirmed',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, user.id, user.name, user.phone, total, itemCount, JSON.stringify(labels), address, slot, payment, date, riderId, key],
    )

    if (payment === 'Wallet') {
      await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2', [total, user.id])
      await client.query('INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,$2,$3,$4)', [user.id, `Order #${id}`, total, 'debit'])
    }
    await client.query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [user.id, 'Order confirmed', `Order #${id} placed — paying by ${payment === 'Wallet' ? 'wallet' : 'cash on delivery'}.`])

    await client.query('COMMIT')
    log.info('order.created', { orderId: id, total, payment })
    res.status(201).json(orderForApp(inserted.rows[0]))
  } catch (err) {
    await client.query('ROLLBACK')
    // Two concurrent submissions with the same key: return the winner.
    if (err.code === '23505' && key) {
      const existing = await one('SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [req.auth.id, key])
      if (existing) return res.status(200).json(orderForApp(existing))
    }
    if (err.status) return res.status(err.status).json({ error: err.message })
    return next(err)
  } finally {
    client.release()
  }
})

// ---- Notifications -----------------------------------------------------------
router.get('/notifications', requireUser, async (req, res) => {
  const { rows } = await query('SELECT id, title, body, unread, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC', [req.auth.id])
  res.json(rows.map((n) => ({ id: n.id, title: n.title, body: n.body, unread: n.unread, time: relativeTime(n.created_at) })))
})

router.post('/notifications/read-all', requireUser, async (req, res) => {
  await query('UPDATE notifications SET unread=false WHERE user_id=$1', [req.auth.id])
  res.json({ ok: true })
})

// ---- Rider -------------------------------------------------------------------
router.get('/rider/deliveries', requireUser, async (req, res) => {
  if (req.auth.role !== 'rider') return res.status(403).json({ error: 'Riders only' })
  const me = await one('SELECT approved FROM users WHERE id=$1', [req.auth.id])
  if (!me?.approved) return res.status(403).json({ error: 'Your account is pending admin approval', pending: true })
  const { rows } = await query(
    `SELECT * FROM orders WHERE rider_id=$1 ORDER BY created_at DESC`,
    [req.auth.id],
  )
  res.json(rows.map(deliveryForApp))
})

router.patch('/rider/deliveries/:id', requireUser, async (req, res) => {
  if (req.auth.role !== 'rider') return res.status(403).json({ error: 'Riders only' })
  const me = await one('SELECT approved FROM users WHERE id=$1', [req.auth.id])
  if (!me?.approved) return res.status(403).json({ error: 'Your account is pending admin approval', pending: true })
  const order = await one('SELECT * FROM orders WHERE id=$1 AND rider_id=$2', [req.params.id, req.auth.id])
  if (!order) return res.status(404).json({ error: 'Delivery not found' })

  const flow = { Confirmed: 'Out for delivery', 'Out for delivery': 'Delivered' }
  // Rider "In transit" maps onto the order lifecycle's "Out for delivery".
  const current = order.status === 'Confirmed' || order.status === 'Packed' ? 'Confirmed' : order.status
  const next = flow[current]
  if (!next) return res.status(400).json({ error: `Delivery is already ${order.status.toLowerCase()}` })

  const updated = await one('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [next, order.id])
  if (updated.user_id) {
    await notifyUser(updated.user_id, {
      title: 'Delivery update',
      body: `Order #${updated.id} is now ${next.toLowerCase()}.`,
      data: { orderId: updated.id, status: next },
    })
  }
  res.json(deliveryForApp(updated))
})

// ---- helpers -----------------------------------------------------------------
function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

async function nextOrderId(client) {
  // Numeric suffix after the MM prefix, next above the current max.
  const { rows } = await client.query(`SELECT COALESCE(MAX(CAST(substring(id from 3) AS INTEGER)), 1051) AS max FROM orders WHERE id ~ '^MM[0-9]+$'`)
  return `MM${rows[0].max + 1}`
}

function orderForApp(o) {
  return {
    id: o.id,
    date: o.date || formatDate(o.created_at),
    time: o.slot || '—',
    status: o.status,
    total: num(o.total),
    itemCount: o.item_count,
    items: Array.isArray(o.items) ? o.items : [],
    address: o.address || '',
  }
}

function deliveryForApp(o) {
  const riderStatus = o.status === 'Delivered' ? 'Completed' : o.status === 'Out for delivery' ? 'In transit' : 'Assigned'
  return {
    id: o.id,
    customer: o.customer_name,
    phone: o.phone || '',
    address: o.address || '',
    slot: o.slot || '—',
    items: (Array.isArray(o.items) ? o.items : []).join(', '),
    amount: num(o.total),
    payment: o.payment || 'Prepaid',
    status: riderStatus,
  }
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
function formatTxDate(ts) {
  return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' })
}
function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? 'Yesterday' : `${days} days ago`
}

export default router
