import { Router } from 'express'
import { pool, query, one } from './db.js'
import { requireUser, signToken } from './auth.js'

const router = Router()
const num = (v) => Number(v)

// Shapes a DB user row into the session payload the app expects.
const publicUser = (u) => ({
  id: u.id,
  role: u.role,
  name: u.name,
  phone: `+91 ${String(u.phone).slice(-10)}`,
  wallet: num(u.wallet_balance),
})

// ---- Auth (demo OTP: any 6 digits) -------------------------------------------
router.post('/auth/request-otp', (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '')
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' })
  // A real deployment would send an SMS here. Demo returns success.
  res.json({ ok: true, message: 'Demo OTP sent' })
})

router.post('/auth/verify-otp', async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '')
  const otp = String(req.body?.otp || '')
  const role = req.body?.role === 'rider' ? 'rider' : 'customer'
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number' })
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter a 6-digit OTP' })

  let user = await one('SELECT * FROM users WHERE role=$1 AND phone=$2', [role, phone])
  if (!user) {
    const name = role === 'rider' ? 'Delivery Partner' : 'Milky Mart Customer'
    user = await one(
      'INSERT INTO users (role, phone, name, wallet_balance) VALUES ($1,$2,$3,$4) RETURNING *',
      [role, phone, name, role === 'rider' ? 0 : 0],
    )
  }
  const token = signToken({ kind: 'user', id: user.id, role: user.role })
  res.json({ token, user: publicUser(user) })
})

router.get('/me', requireUser, async (req, res) => {
  const user = await one('SELECT * FROM users WHERE id=$1', [req.auth.id])
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ user: publicUser(user) })
})

router.patch('/me', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40)
  if (!name) return res.status(400).json({ error: 'Name cannot be empty' })
  const user = await one('UPDATE users SET name=$1 WHERE id=$2 RETURNING *', [name, req.auth.id])
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
  const row = await one('INSERT INTO addresses (user_id, label, detail) VALUES ($1,$2,$3) RETURNING id, label, detail', [req.auth.id, label, detail])
  res.status(201).json({ id: String(row.id), label: row.label, detail: row.detail })
})

router.put('/addresses/:id', requireUser, async (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 20)
  const detail = String(req.body?.detail || '').trim().slice(0, 140)
  if (!label || !detail) return res.status(400).json({ error: 'Add both a label and a full address' })
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

router.post('/wallet/topup', requireUser, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount))
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than ₹0' })
  if (amount > 50000) return res.status(400).json({ error: 'Maximum is ₹50,000 per top-up' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const label = req.auth.role === 'rider' ? 'Wallet adjustment' : 'Wallet top-up'
    const { rows: u } = await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2 RETURNING wallet_balance', [amount, req.auth.id])
    await client.query('INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,$2,$3,$4)', [req.auth.id, label, amount, 'credit'])
    await client.query('COMMIT')
    res.json({ balance: num(u[0].wallet_balance) })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
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

router.post('/orders', requireUser, async (req, res) => {
  const { items, address, slot, payment, date } = req.body || {}
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Your cart is empty' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.auth.id])
    const user = userRows[0]

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

    if (payment === 'Wallet' && Number(user.wallet_balance) < total) {
      throw httpError(400, 'Wallet balance is too low — pick another payment method')
    }

    const id = await nextOrderId(client)
    const inserted = await client.query(
      `INSERT INTO orders (id, user_id, customer_name, phone, status, total, item_count, items, address, slot, payment, date)
       VALUES ($1,$2,$3,$4,'Confirmed',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, user.id, user.name, user.phone, total, itemCount, JSON.stringify(labels), address, slot, payment, date],
    )

    if (payment === 'Wallet') {
      await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2', [total, user.id])
      await client.query('INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,$2,$3,$4)', [user.id, `Order #${id}`, total, 'debit'])
    }
    await client.query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [user.id, 'Order confirmed', `Order #${id} has been placed successfully.`])

    await client.query('COMMIT')
    res.status(201).json(orderForApp(inserted.rows[0]))
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.status) return res.status(err.status).json({ error: err.message })
    throw err
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
  const { rows } = await query(
    `SELECT * FROM orders WHERE rider_id=$1 ORDER BY created_at DESC`,
    [req.auth.id],
  )
  res.json(rows.map(deliveryForApp))
})

router.patch('/rider/deliveries/:id', requireUser, async (req, res) => {
  if (req.auth.role !== 'rider') return res.status(403).json({ error: 'Riders only' })
  const order = await one('SELECT * FROM orders WHERE id=$1 AND rider_id=$2', [req.params.id, req.auth.id])
  if (!order) return res.status(404).json({ error: 'Delivery not found' })

  const flow = { Confirmed: 'Out for delivery', 'Out for delivery': 'Delivered' }
  // Rider "In transit" maps onto the order lifecycle's "Out for delivery".
  const current = order.status === 'Confirmed' || order.status === 'Packed' ? 'Confirmed' : order.status
  const next = flow[current]
  if (!next) return res.status(400).json({ error: `Delivery is already ${order.status.toLowerCase()}` })

  const updated = await one('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [next, order.id])
  if (updated.user_id) {
    await query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [updated.user_id, 'Delivery update', `Order #${updated.id} is now ${next.toLowerCase()}.`])
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
