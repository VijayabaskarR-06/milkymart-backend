import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { query, one } from './db.js'
import { requireAdmin, signToken } from './auth.js'
import { seedDatabase } from './migrate.js'

const router = Router()
const num = (v) => Number(v)

// ---- Admin auth --------------------------------------------------------------
router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
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
router.get('/orders', async (req, res) => {
  const status = req.query.status
  const params = []
  let where = ''
  if (status && status !== 'all') {
    params.push(status)
    where = 'WHERE o.status = $1'
  }
  const { rows } = await query(
    `SELECT o.*, r.name AS rider_name FROM orders o
     LEFT JOIN users r ON r.id = o.rider_id ${where}
     ORDER BY o.created_at DESC`,
    params,
  )
  res.json(rows.map(adminOrder))
})

router.patch('/orders/:id', async (req, res) => {
  const allowed = ['Confirmed', 'Packed', 'Out for delivery', 'Delivered', 'Cancelled']
  const status = req.body?.status
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' })
  const order = await one('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id])
  if (!order) return res.status(404).json({ error: 'Order not found' })
  if (order.user_id) {
    await query('INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)', [order.user_id, 'Order update', `Order #${order.id} is now ${status.toLowerCase()}.`])
  }
  res.json(adminOrder(order))
})

// ---- Products ----------------------------------------------------------------
router.get('/products', async (_req, res) => {
  const { rows } = await query('SELECT * FROM products ORDER BY sort_order, name')
  res.json(rows.map(adminProduct))
})

router.post('/products', async (req, res) => {
  const { id, name, size, price, mrp, category, badge, description, image, stock } = req.body || {}
  if (!id || !name || price == null) return res.status(400).json({ error: 'id, name and price are required' })
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
    SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id)::int AS order_count
    FROM users u WHERE u.role='customer' ORDER BY u.created_at
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
      recharges: recharges.map((r) => ({ date: new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), amount: num(r.amount), mode: r.type === 'credit' ? 'Credit' : 'Debit' })),
    })
  }
  res.json(out)
})

router.get('/riders', async (_req, res) => {
  const { rows } = await query(`
    SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id)::int AS assigned,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id=u.id AND o.status='Delivered')::int AS delivered
    FROM users u WHERE u.role='rider' ORDER BY u.created_at
  `)
  res.json(rows.map((u) => ({
    id: u.id,
    name: u.name,
    mobile: `+91 ${String(u.phone).slice(-10)}`,
    wallet: num(u.wallet_balance),
    assigned: u.assigned,
    delivered: u.delivered,
    initials: initials(u.name),
  })))
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
