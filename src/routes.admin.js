import { Router } from 'express'
import express from 'express'
import bcrypt from 'bcryptjs'
import { storageConfigured, uploadProductImage } from './storage.js'
import { pool, query, one } from './db.js'
import { requireAdmin, signToken } from './auth.js'
import { seedDatabase } from './migrate.js'
import { validate, schemas, canTransition, allowedNext } from './validate.js'
import { notifyUser } from './notify.js'
import { log } from './logger.js'
import { recordAudit } from './audit.js'

const router = Router()
const num = (v) => Number(v)

// ---- Admin auth --------------------------------------------------------------
router.post('/login', validate(schemas.adminLogin), async (req, res) => {
  const email = req.valid.email.toLowerCase()
  const password = req.valid.password
  const admin = await one('SELECT * FROM admins WHERE email=$1', [email])
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }
  const token = signToken({ kind: 'admin', id: admin.id, email: admin.email, tv: admin.token_version ?? 0 })
  res.json({ token, admin: { email: admin.email, name: admin.name } })
})

router.use(requireAdmin)

// Lets the signed-in admin change their own password. Requires the current
// password (so a hijacked-but-still-logged-in tab can't silently lock the
// real owner out) and bumps token_version, which signs every other admin
// session out — the browser making this call gets a fresh token back so it
// keeps working.
router.post('/change-password', validate(schemas.adminChangePassword), async (req, res) => {
  const { currentPassword, newPassword } = req.valid
  const admin = await one('SELECT * FROM admins WHERE id=$1', [req.admin.id])
  // 400, not 401 — the admin panel treats any 401 as "session expired, log
  // out", which would wrongly boot someone out just for mistyping it.
  if (!admin || !bcrypt.compareSync(currentPassword, admin.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' })
  }
  const hash = bcrypt.hashSync(newPassword, 10)
  const { rows } = await query(
    `UPDATE admins SET password_hash=$1, token_version=token_version+1, password_changed_at=now()
     WHERE id=$2 RETURNING token_version`,
    [hash, admin.id],
  )
  const token = signToken({ kind: 'admin', id: admin.id, email: admin.email, tv: rows[0].token_version })
  log.info('admin.password_changed', { admin: admin.id })
  await recordAudit(req, 'admin.password_changed', { targetType: 'admin', targetId: admin.id })
  res.json({ ok: true, token })
})

// Restore the demo dataset (admin-only). Handy for showing a clean slate.
router.post('/reset', async (req, res) => {
  await seedDatabase({ force: true })
  await recordAudit(req, 'demo.reset')
  res.json({ ok: true })
})

// Recent admin activity — wallet credits, product edits, rider approvals,
// order overrides, password changes. Newest first.
router.get('/audit-log', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
  const { rows } = await query(
    `SELECT id, admin_email, action, target_type, target_id, meta, created_at
     FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
  )
  res.json(rows.map((r) => ({
    id: r.id,
    admin: r.admin_email,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    meta: r.meta,
    date: new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
  })))
})

// ---- Dashboard KPIs ----------------------------------------------------------
router.get('/overview', async (_req, res) => {
  const totals = await one(`
    SELECT
      (SELECT COUNT(*) FROM orders)::int AS total_orders,
      (SELECT COUNT(*) FROM orders WHERE status NOT IN ('Delivered','Cancelled'))::int AS active_orders,
      (SELECT COUNT(*) FROM orders WHERE status='Delivered')::int AS delivered_orders,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE status <> 'Cancelled')::numeric AS revenue,
      (SELECT COUNT(*) FROM users WHERE role='customer')::int AS customers,
      (SELECT COUNT(*) FROM users WHERE role='rider')::int AS riders,
      (SELECT COUNT(*) FROM products WHERE active=true)::int AS products
  `)
  // Revenue for the last 7 days, oldest first — drives the admin sparkline.
  const { rows: series } = await query(`
    SELECT to_char(d::date,'Dy') AS label, COALESCE(SUM(o.total),0)::numeric AS value
    FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') d
    LEFT JOIN orders o ON o.created_at::date = d::date AND o.status <> 'Cancelled'
    GROUP BY d ORDER BY d
  `)
  res.json({
    kpis: {
      totalOrders: totals.total_orders,
      activeOrders: totals.active_orders,
      deliveredOrders: totals.delivered_orders,
      revenue: num(totals.revenue),
      customers: totals.customers,
      riders: totals.riders,
      products: totals.products,
    },
    revenueSeries: series.map((r) => ({ label: r.label.trim(), value: num(r.value) })),
  })
})

// ---- Orders ------------------------------------------------------------------
// Paginated so the list stays fast as order volume grows.
// Returns { items, total, limit, offset }; older clients can still read `items`.
router.get('/orders', async (req, res) => {
  const status = req.query.status
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
  const filters = []
  const params = []
  if (status && status !== 'all') {
    params.push(status)
    filters.push(`o.status = $${params.length}`)
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  const totalRow = await one(`SELECT COUNT(*)::int AS n FROM orders o ${where}`, params)
  const { rows } = await query(
    `SELECT o.*, r.name AS rider_name FROM orders o
     LEFT JOIN users r ON r.id = o.rider_id ${where}
     ORDER BY o.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  res.json({ items: rows.map(adminOrder), total: totalRow.n, limit, offset })
})

router.patch('/orders/:id', validate(schemas.orderStatus), async (req, res) => {
  const { status } = req.valid
  const current = await one('SELECT * FROM orders WHERE id=$1', [req.params.id])
  if (!current) return res.status(404).json({ error: 'Order not found' })
  // An order can't move backwards or skip the delivery lifecycle.
  if (!canTransition(current.status, status)) {
    return res.status(409).json({
      error: `Can't move an order from "${current.status}" to "${status}"`,
      allowed: allowedNext(current.status),
    })
  }
  const order = await one('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id])
  if (order.user_id && current.status !== status) {
    await notifyUser(order.user_id, {
      title: 'Order update',
      body: `Order #${order.id} is now ${status.toLowerCase()}.`,
      data: { orderId: order.id, status },
    })
  }
  log.info('admin.order_status', { orderId: order.id, from: current.status, to: status })
  await recordAudit(req, 'order.status_changed', { targetType: 'order', targetId: order.id, meta: { from: current.status, to: status } })
  res.json(adminOrder(order))
})

// ---- Product image upload ----------------------------------------------------
// Accepts a base64 data URL (bigger body limit than the rest of the API) and
// returns a CDN URL to store on the product.
router.post('/uploads/product-image', express.json({ limit: '8mb' }), async (req, res, next) => {
  if (!storageConfigured) {
    return res.status(400).json({ error: 'Image storage is not configured', notConfigured: true })
  }
  try {
    const result = await uploadProductImage(req.body?.dataUrl, req.body?.name || 'product')
    if (!result.ok) return res.status(400).json({ error: result.error })
    res.json({ url: result.url, publicId: result.publicId })
  } catch (err) {
    next(err)
  }
})

// ---- Products ----------------------------------------------------------------
router.get('/products', async (_req, res) => {
  const { rows } = await query('SELECT * FROM products ORDER BY sort_order, name')
  res.json(rows.map(adminProduct))
})

router.post('/products', validate(schemas.product), async (req, res) => {
  const { id, name, size, price, mrp, category, badge, description, image, stock } = req.valid
  try {
    const row = await one(
      `INSERT INTO products (id, name, size, price, mrp, category, badge, description, image, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-'), name, size || '500 ml', price, mrp ?? price, category || 'Milk', badge || null, description || '', image || '/assets/images/milk1.png', stock ?? 100],
    )
    await recordAudit(req, 'product.created', { targetType: 'product', targetId: row.id, meta: { name: row.name, price: num(row.price) } })
    res.status(201).json(adminProduct(row))
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with that id already exists' })
    throw err
  }
})

router.patch('/products/:id', async (req, res) => {
  const fields = ['name', 'size', 'price', 'mrp', 'category', 'badge', 'description', 'image', 'stock', 'active']
  const sets = []
  const params = []
  for (const f of fields) {
    if (req.body?.[f] !== undefined) {
      params.push(req.body[f])
      sets.push(`${f} = $${params.length}`)
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })
  params.push(req.params.id)
  const row = await one(`UPDATE products SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params)
  if (!row) return res.status(404).json({ error: 'Product not found' })
  await recordAudit(req, 'product.updated', { targetType: 'product', targetId: row.id, meta: { fields: sets.map((s) => s.split(' ')[0]) } })
  res.json(adminProduct(row))
})

router.delete('/products/:id', async (req, res) => {
  await query('UPDATE products SET active=false WHERE id=$1', [req.params.id])
  await recordAudit(req, 'product.deleted', { targetType: 'product', targetId: req.params.id })
  res.json({ ok: true })
})

// ---- Customers & riders ------------------------------------------------------
router.get('/customers', async (_req, res) => {
  const { rows } = await query(`
    SELECT u.*, r.name AS rider_name,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id)::int AS order_count
    FROM users u
    LEFT JOIN users r ON r.id = u.assigned_rider_id
    WHERE u.role='customer' ORDER BY u.created_at
  `)
  const out = []
  for (const u of rows) {
    const { rows: recharges } = await query(
      `SELECT label, amount, type, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [u.id],
    )
    out.push({
      id: u.id,
      name: u.name,
      mobile: `+91 ${String(u.phone).slice(-10)}`,
      wallet: num(u.wallet_balance),
      orders: u.order_count,
      initials: initials(u.name),
      assignedRiderId: u.assigned_rider_id,
      assignedRiderName: u.rider_name || null,
      recharges: recharges.map((r) => ({ date: new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), amount: num(r.amount), mode: r.type === 'credit' ? 'Credit' : 'Debit', label: r.label })),
    })
  }
  res.json(out)
})

// Full order history for one customer, newest first.
router.get('/customers/:id/orders', async (req, res) => {
  const customer = await one(`SELECT id, name, phone, wallet_balance FROM users WHERE id=$1 AND role='customer'`, [req.params.id])
  if (!customer) return res.status(404).json({ error: 'Customer not found' })
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200)
  const { rows } = await query(
    `SELECT o.*, r.name AS rider_name FROM orders o
     LEFT JOIN users r ON r.id = o.rider_id
     WHERE o.user_id=$1 ORDER BY o.created_at DESC LIMIT ${limit}`,
    [customer.id],
  )
  const orders = rows.map(adminOrder)
  const spent = orders.filter((o) => o.status !== 'Cancelled').reduce((sum, o) => sum + o.total, 0)
  res.json({
    customer: {
      id: customer.id,
      name: customer.name,
      mobile: `+91 ${String(customer.phone).slice(-10)}`,
      wallet: num(customer.wallet_balance),
    },
    orders,
    summary: {
      count: orders.length,
      spent,
      delivered: orders.filter((o) => o.status === 'Delivered').length,
      active: orders.filter((o) => !['Delivered', 'Cancelled'].includes(o.status)).length,
    },
  })
})

// Credit (or debit) a customer's wallet. Customers cannot top up themselves —
// they hand cash to the delivery partner and an admin loads it here. A positive
// amount adds money; a negative amount corrects a mistake. Recorded as a
// transaction so it shows in the customer's wallet history.
router.post('/customers/:id/wallet', async (req, res) => {
  const amount = Math.round(Number(req.body?.amount))
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Enter a non-zero amount' })
  if (Math.abs(amount) > 100000) return res.status(400).json({ error: 'Amount is too large' })
  const note = String(req.body?.note || '').slice(0, 80).trim()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2 AND role='customer' RETURNING id, name, wallet_balance`,
      [amount, req.params.id],
    )
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer not found' }) }
    if (num(rows[0].wallet_balance) < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That would make the balance negative' }) }
    const label = note || (amount > 0 ? 'Cash added by delivery partner' : 'Wallet adjustment')
    await client.query(
      'INSERT INTO transactions (user_id, label, amount, type) VALUES ($1,$2,$3,$4)',
      [req.params.id, label, Math.abs(amount), amount > 0 ? 'credit' : 'debit'],
    )
    await client.query('COMMIT')
    notifyUser(req.params.id, {
      title: amount > 0 ? 'Wallet updated' : 'Wallet adjusted',
      body: amount > 0 ? `₹${amount} was added to your wallet.` : `₹${Math.abs(amount)} was deducted from your wallet.`,
    }).catch(() => {})
    log.info('admin.wallet_credit', { customer: req.params.id, amount })
    await recordAudit(req, 'customer.wallet_adjusted', { targetType: 'customer', targetId: req.params.id, meta: { amount, note: label } })
    res.json({ ok: true, wallet: num(rows[0].wallet_balance) })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
})

// Assign (or clear) a customer's permanent delivery partner. The rider must be
// approved. Pass riderId: null to unassign.
router.post('/customers/:id/assign-rider', validate(schemas.assignRider), async (req, res) => {
  const riderId = req.valid.riderId ?? null
  if (riderId !== null) {
    const rider = await one(`SELECT id, approved FROM users WHERE id=$1 AND role='rider'`, [riderId])
    if (!rider) return res.status(404).json({ error: 'Rider not found' })
    if (!rider.approved) return res.status(400).json({ error: 'Approve the rider before assigning them' })
  }
  const customer = await one(`UPDATE users SET assigned_rider_id=$1 WHERE id=$2 AND role='customer' RETURNING id`, [riderId, req.params.id])
  if (!customer) return res.status(404).json({ error: 'Customer not found' })
  await recordAudit(req, 'customer.rider_assigned', { targetType: 'customer', targetId: req.params.id, meta: { riderId } })
  res.json({ ok: true })
})

router.get('/riders', async (_req, res) => {
  const { rows } = await query(`
    SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id)::int AS assigned,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='Delivered')::int AS delivered,
      (SELECT COUNT(*) FROM users c WHERE c.assigned_rider_id=u.id)::int AS customers
    FROM users u WHERE u.role='rider' ORDER BY u.approved, u.created_at
  `)
  const out = []
  for (const u of rows) {
    // Every self-added wallet adjustment carries the rider's own reason (see
    // POST /wallet/topup) — surfaced here so a "we paid, you never added it"
    // claim can be checked against what the rider actually logged.
    const { rows: recharges } = await query(
      `SELECT label, amount, type, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 10`,
      [u.id],
    )
    out.push({
      id: u.id,
      name: u.name,
      mobile: `+91 ${String(u.phone).slice(-10)}`,
      wallet: num(u.wallet_balance),
      approved: Boolean(u.approved),
      assigned: u.assigned,
      delivered: u.delivered,
      customers: u.customers,
      initials: initials(u.name),
      recharges: recharges.map((r) => ({ date: new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), amount: num(r.amount), mode: r.type === 'credit' ? 'Credit' : 'Debit', label: r.label })),
    })
  }
  res.json(out)
})

// Approve (or revoke) a rider. Revoking also clears them from any customers.
router.post('/riders/:id/approve', validate(schemas.approveRider), async (req, res) => {
  const approved = req.valid.approved
  const rider = await one(`UPDATE users SET approved=$1 WHERE id=$2 AND role='rider' RETURNING id`, [approved, req.params.id])
  if (!rider) return res.status(404).json({ error: 'Rider not found' })
  if (!approved) {
    await query('UPDATE users SET assigned_rider_id=NULL WHERE assigned_rider_id=$1', [req.params.id])
  }
  await recordAudit(req, approved ? 'rider.approved' : 'rider.revoked', { targetType: 'rider', targetId: req.params.id })
  res.json({ ok: true })
})

function adminOrder(o) {
  return {
    id: o.id,
    customer: o.customer_name,
    phone: o.phone,
    status: o.status,
    total: num(o.total),
    itemCount: o.item_count,
    items: Array.isArray(o.items) ? o.items : [],
    address: o.address,
    slot: o.slot,
    payment: o.payment,
    rider: o.rider_name || null,
    date: o.date || new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
  }
}

function adminProduct(p) {
  return {
    id: p.id,
    name: p.name,
    size: p.size,
    price: num(p.price),
    mrp: p.mrp != null ? num(p.mrp) : null,
    offer: p.mrp && Number(p.mrp) > Number(p.price) ? Math.round((1 - Number(p.price) / Number(p.mrp)) * 100) : 0,
    category: p.category,
    badge: p.badge,
    description: p.description,
    image: p.image,
    stock: p.stock,
    active: p.active,
  }
}

function initials(name) {
  return String(name).split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('')
}

export default router
