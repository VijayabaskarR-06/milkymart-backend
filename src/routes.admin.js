import { Router } from 'express'
import express from 'express'
import bcrypt from 'bcryptjs'
import { storageConfigured, uploadProductImage } from './storage.js'
import { query, one } from './db.js'
import { requireAdmin, signToken } from './auth.js'
import { seedDatabase } from './migrate.js'
import { validate, schemas, canTransition, allowedNext } from './validate.js'
import { notifyUser } from './notify.js'
import { log } from './logger.js'

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
  const token = signToken({ kind: 'admin', id: admin.id, email: admin.email })
  res.json({ token, admin: { email: admin.email, name: admin.name } })
})

router.use(requireAdmin)

// Restore the demo dataset (admin-only). Handy for showing a clean slate.
router.post('/reset', async (_req, res) => {
  await seedDatabase({ force: true })
  res.json({ ok: true })
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
  res.json(adminProduct(row))
})

router.delete('/products/:id', async (req, res) => {
  await query('UPDATE products SET active=false WHERE id=$1', [req.params.id])
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
      recharges: recharges.map((r) => ({ date: new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), amount: num(r.amount), mode: r.type === 'credit' ? 'Credit' : 'Debit' })),
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
  res.json(rows.map((u) => ({
    id: u.id,
    name: u.name,
    mobile: `+91 ${String(u.phone).slice(-10)}`,
    wallet: num(u.wallet_balance),
    approved: Boolean(u.approved),
    assigned: u.assigned,
    delivered: u.delivered,
    customers: u.customers,
    initials: initials(u.name),
  })))
})

// Approve (or revoke) a rider. Revoking also clears them from any customers.
router.post('/riders/:id/approve', validate(schemas.approveRider), async (req, res) => {
  const approved = req.valid.approved
  const rider = await one(`UPDATE users SET approved=$1 WHERE id=$2 AND role='rider' RETURNING id`, [approved, req.params.id])
  if (!rider) return res.status(404).json({ error: 'Rider not found' })
  if (!approved) {
    await query('UPDATE users SET assigned_rider_id=NULL WHERE assigned_rider_id=$1', [req.params.id])
  }
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
