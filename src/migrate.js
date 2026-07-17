import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import bcrypt from 'bcryptjs'
import { pool, query } from './db.js'

const here = dirname(fileURLToPath(import.meta.url))

// Products mirror the mobile app catalogue so the app, admin panel, and DB agree.
const PRODUCTS = [
  { id: 'farm-fresh', name: 'Farm Fresh Milk', size: '1 litre', price: 68, mrp: 72, image: '/assets/images/Glass_milk.png', badge: 'Bestseller', category: 'Milk', description: 'Pure, creamy goodness from grass-fed cows, chilled fresh every morning.' },
  { id: 'nandini', name: 'Nandini Toned Milk', size: '500 ml', price: 28, mrp: 30, image: '/assets/images/milk1.png', badge: 'Fresh', category: 'Milk', description: 'Balanced everyday milk with dependable quality and a clean taste.' },
  { id: 'amul', name: 'Amul Moti Milk', size: '450 ml', price: 35, mrp: 38, image: '/assets/images/milk2.jpg', badge: 'Popular', category: 'Milk', description: 'Convenient, wholesome toned milk for tea, coffee and breakfast.' },
  { id: 'madhusudan', name: 'Full Cream Milk', size: '500 ml', price: 36, mrp: 36, image: '/assets/images/milk3.jpg', badge: null, category: 'Milk', description: 'Rich full-cream milk with a smooth body and naturally creamy flavour.' },
  { id: 'farmers', name: 'Farmers’ Milk', size: '1 litre', price: 72, mrp: 78, image: '/assets/images/milk4.jpg', badge: null, category: 'Milk', description: 'Naturally sourced milk packed in a practical family-size carton.' },
  { id: 'milma', name: 'Milma Prime', size: '500 ml', price: 32, mrp: 34, image: '/assets/images/milk5.jpg', badge: 'New', category: 'Milk', description: 'Pasteurised standardised milk with a rich and satisfying finish.' },
  { id: 'medha', name: 'Medha Gold', size: '500 ml', price: 34, mrp: 36, image: '/assets/images/milk6.jpg', badge: null, category: 'Milk', description: 'Creamy premium milk made for families who prefer a fuller taste.' },
  { id: 'classic-cow', name: 'Classic Cow Milk', size: '500 ml', price: 40, mrp: 44, image: '/assets/images/milk7.jpg', badge: 'Organic', category: 'Milk', description: 'Classic farm-style cow milk with freshness sealed inside.' },
]

const CUSTOMERS = [
  { phone: '9876543210', name: 'Aarav Sharma', wallet: 1250 },
  { phone: '9811044120', name: 'Kabir Singh', wallet: 640 },
  { phone: '9876122882', name: 'Meera Nair', wallet: 320 },
]

const RIDERS = [
  { phone: '9998887770', name: 'Rohan Kumar', wallet: 840 },
]

export async function ensureSchema() {
  await query(readFileSync(join(here, 'schema.sql'), 'utf8'))
}

// Wipes and repopulates the demo dataset. Used by `npm run migrate` (first run)
// and the admin "reset demo" action.
export async function seedDatabase({ force = false } = {}) {
  await ensureSchema()
  const { rows: existing } = await query('SELECT COUNT(*)::int AS n FROM products')
  if (existing[0].n > 0 && !force) return { seeded: false }
  if (force) {
    await query('TRUNCATE users, products, addresses, orders, transactions, notifications RESTART IDENTITY CASCADE')
  }
  await seedRows()
  return { seeded: true }
}

async function seed() {
  await ensureSchema()

  const { rows: existing } = await query('SELECT COUNT(*)::int AS n FROM products')
  if (existing[0].n > 0) {
    console.log('Database already seeded; running schema only.')
    await seedAdmin()
    return
  }
  await seedRows()
}

async function seedRows() {

  for (const [i, p] of PRODUCTS.entries()) {
    await query(
      `INSERT INTO products (id, name, size, price, mrp, image, badge, description, category, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, p.name, p.size, p.price, p.mrp, p.image, p.badge, p.description, p.category, i],
    )
  }

  const userIds = {}
  for (const c of CUSTOMERS) {
    const { rows } = await query(
      `INSERT INTO users (role, phone, name, wallet_balance) VALUES ('customer',$1,$2,$3) RETURNING id`,
      [c.phone, c.name, c.wallet],
    )
    userIds[c.phone] = rows[0].id
  }
  for (const r of RIDERS) {
    const { rows } = await query(
      `INSERT INTO users (role, phone, name, wallet_balance) VALUES ('rider',$1,$2,$3) RETURNING id`,
      [r.phone, r.name, r.wallet],
    )
    userIds[r.phone] = rows[0].id
  }

  const aarav = userIds['9876543210']
  const rohan = userIds['9998887770']

  await query(
    `INSERT INTO addresses (user_id, label, detail) VALUES
     ($1,'Home','22, Green Park Road, Bengaluru 560003'),
     ($1,'Work','4th Floor, Orion Tech Park, Whitefield, Bengaluru 560066')`,
    [aarav],
  )

  await query(
    `INSERT INTO orders (id, user_id, customer_name, phone, status, total, item_count, items, address, slot, payment, date, rider_id)
     VALUES
     ('MM1048',$1,'Aarav Sharma','+91 98765 43210','Out for delivery',136,2,$2,'22, Green Park Road, Bengaluru','6:00 – 8:00 AM','Prepaid','17 Jul 2026',$3),
     ('MM1033',$1,'Aarav Sharma','+91 98765 43210','Delivered',100,3,$4,'22, Green Park Road, Bengaluru','6:00 – 8:00 AM','Wallet','15 Jul 2026',$3)`,
    [aarav, JSON.stringify(['2 × Farm Fresh Milk']), rohan, JSON.stringify(['1 × Nandini Toned Milk', '2 × Full Cream Milk'])],
  )

  await query(
    `INSERT INTO orders (id, user_id, customer_name, phone, status, total, item_count, items, address, slot, payment, date, rider_id)
     VALUES
     ('MM1051',$1,'Meera Nair','+91 98761 22882','Confirmed',60,2,$2,'16, Lake View Avenue, Bengaluru','6:00 – 8:00 AM','Cash on delivery','17 Jul 2026',$3)`,
    [userIds['9876122882'], JSON.stringify(['1 × Milma Prime', '1 × Nandini Toned Milk']), rohan],
  )

  await query(
    `INSERT INTO transactions (user_id, label, amount, type, created_at) VALUES
     ($1,'Wallet top-up',500,'credit', now() - interval '1 day'),
     ($1,'Order #MM1033',100,'debit', now() - interval '2 day'),
     ($1,'Promotional bonus',50,'credit', now() - interval '5 day')`,
    [aarav],
  )
  await query(
    `INSERT INTO transactions (user_id, label, amount, type, created_at) VALUES
     ($1,'Delivery payout',240,'credit', now() - interval '1 day'),
     ($1,'Incentive bonus',150,'credit', now() - interval '3 day')`,
    [rohan],
  )

  await query(
    `INSERT INTO notifications (user_id, title, body, unread, created_at) VALUES
     ($1,'Your order is on the way','Delivery #MM1048 will reach you between 6:00 and 8:00 AM.',true, now() - interval '10 minutes'),
     ($1,'Wallet updated','₹500 was added successfully to your Milky Mart wallet.',true, now() - interval '1 day'),
     ($1,'Fresh morning offer','Save 10% when you schedule milk for 7 consecutive mornings.',false, now() - interval '2 day')`,
    [aarav],
  )

  await seedAdmin()
}

export async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@milkymart.app'
  const password = process.env.ADMIN_PASSWORD || 'milkymart123'
  const hash = bcrypt.hashSync(password, 10)
  await query(
    `INSERT INTO admins (email, password_hash, name) VALUES ($1,$2,'Administrator')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, hash],
  )
}

// Only run as a script (node src/migrate.js), not when imported by the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => {
      console.log('Seed complete.')
      console.log(`  Admin login: ${process.env.ADMIN_EMAIL || 'admin@milkymart.app'} / ${process.env.ADMIN_PASSWORD || 'milkymart123'}`)
      console.log('  Demo customer phone: 9876543210 (any 6-digit OTP)')
      console.log('  Demo rider phone:    9998887770')
      return pool.end()
    })
    .catch((err) => {
      console.error('Migration failed:', err)
      process.exit(1)
    })
}
