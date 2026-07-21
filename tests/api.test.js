import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'

// Runs against a live server (started by CI or `npm start`).
const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000'

const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data, headers: res.headers }
}

const login = async (phone, role = 'customer') =>
  (await call('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: '111111', role } })).data

let admin
const PATNA = 'H.No 22, Road 10, Kankarbagh, Patna 800020'

before(async () => {
  // Wait for the API to be reachable, then reset to the known demo dataset.
  for (let i = 0; i < 30; i++) {
    try {
      const h = await call('/health')
      if (h.status === 200) break
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  admin = (await call('/api/admin/login', {
    method: 'POST',
    body: { email: process.env.ADMIN_EMAIL || 'admin@milkymart.app', password: process.env.ADMIN_PASSWORD || 'milkymart123' },
  })).data
  assert.ok(admin?.token, 'admin login should succeed')
  await call('/api/admin/reset', { method: 'POST', token: admin.token })
})

describe('health & config', () => {
  test('health reports ok', async () => {
    const res = await call('/health')
    assert.equal(res.status, 200)
    assert.equal(res.data.status, 'ok')
  })

  test('every response carries a request id', async () => {
    const res = await call('/health')
    assert.ok(res.headers.get('x-request-id'))
  })

  test('config advertises integration state', async () => {
    const res = await call('/api/config')
    assert.equal(typeof res.data.liveOtp, 'boolean')
    assert.equal(typeof res.data.livePayments, 'boolean')
  })
})

describe('auth', () => {
  test('rejects a malformed phone number', async () => {
    const res = await call('/api/auth/request-otp', { method: 'POST', body: { phone: '123' } })
    assert.equal(res.status, 400)
  })

  test('issues a token and identifies the user', async () => {
    const session = await login('9876543210')
    assert.ok(session.token)
    const me = await call('/api/me', { token: session.token })
    assert.equal(me.status, 200)
    assert.equal(me.data.user.role, 'customer')
  })

  test('logout invalidates the token server-side', async () => {
    const session = await login('9876543210')
    assert.equal((await call('/api/me', { token: session.token })).status, 200)
    await call('/api/auth/logout', { method: 'POST', token: session.token })
    assert.equal((await call('/api/me', { token: session.token })).status, 401)
  })

  test('unauthenticated requests are rejected', async () => {
    assert.equal((await call('/api/orders')).status, 401)
  })
})

describe('orders', () => {
  test('server recomputes the total and ignores a client-supplied one', async () => {
    const s = await login('9876543210')
    const res = await call('/api/orders', {
      method: 'POST', token: s.token,
      body: { items: [{ id: 'farm-fresh', quantity: 1 }], total: 1, address: PATNA, slot: '6-8', date: 'today' },
    })
    assert.equal(res.status, 201)
    assert.equal(res.data.total, 68)
  })

  test('the same idempotency key never creates two orders', async () => {
    const s = await login('9876543210')
    const body = { items: [{ id: 'nandini', quantity: 1 }], address: PATNA, slot: '6-8', date: 'today', idempotencyKey: `test-${Date.now()}` }
    const results = await Promise.all(Array.from({ length: 4 }, () => call('/api/orders', { method: 'POST', token: s.token, body })))
    const ids = new Set(results.map((r) => r.data.id))
    assert.equal(ids.size, 1, 'concurrent submits must collapse to one order')
  })

  test('pays by wallet when it covers the bill, else cash on delivery', async () => {
    const s = await login('9876543210')
    const small = await call('/api/orders', { method: 'POST', token: s.token, body: { items: [{ id: 'nandini', quantity: 1 }], address: PATNA } })
    assert.equal(small.status, 201)
    const orders = (await call('/api/admin/orders?limit=200', { token: admin.token })).data.items
    assert.equal(orders.find((o) => o.id === small.data.id).payment, 'Wallet')

    const huge = await call('/api/orders', { method: 'POST', token: s.token, body: { items: [{ id: 'farmers', quantity: 99 }], address: PATNA } })
    const orders2 = (await call('/api/admin/orders?limit=200', { token: admin.token })).data.items
    assert.equal(orders2.find((o) => o.id === huge.data.id).payment, 'Cash on delivery')
  })

  test('rejects an empty cart', async () => {
    const s = await login('9876543210')
    const res = await call('/api/orders', { method: 'POST', token: s.token, body: { items: [], address: PATNA } })
    assert.equal(res.status, 400)
  })
})

describe('service area', () => {
  test('accepts a Patna address', async () => {
    const s = await login('9876543210')
    const res = await call('/api/addresses', { method: 'POST', token: s.token, body: { label: 'Test', detail: '9 Rajendra Nagar, Patna 800016' } })
    assert.equal(res.status, 201)
  })

  test('declines an address outside Patna', async () => {
    const s = await login('9876543210')
    const res = await call('/api/addresses', { method: 'POST', token: s.token, body: { label: 'Bad', detail: '12 Marine Drive, Mumbai 400002' } })
    assert.equal(res.status, 422)
    assert.match(res.data.error, /not available/i)
  })

  test('declines an order delivered outside Patna', async () => {
    const s = await login('9876543210')
    const res = await call('/api/orders', { method: 'POST', token: s.token, body: { items: [{ id: 'nandini', quantity: 1 }], address: 'Andheri, Mumbai 400053' } })
    assert.equal(res.status, 422)
  })
})

describe('order lifecycle', () => {
  test('cannot move an order backwards or skip a step', async () => {
    const s = await login('9876543210')
    const order = (await call('/api/orders', { method: 'POST', token: s.token, body: { items: [{ id: 'nandini', quantity: 1 }], address: PATNA } })).data

    const skip = await call(`/api/admin/orders/${order.id}`, { method: 'PATCH', token: admin.token, body: { status: 'Delivered' } })
    assert.equal(skip.status, 409)

    const forward = await call(`/api/admin/orders/${order.id}`, { method: 'PATCH', token: admin.token, body: { status: 'Packed' } })
    assert.equal(forward.status, 200)

    const backwards = await call(`/api/admin/orders/${order.id}`, { method: 'PATCH', token: admin.token, body: { status: 'Confirmed' } })
    assert.equal(backwards.status, 409)
  })

  test('an admin status change notifies the customer', async () => {
    const s = await login('9876543210')
    const order = (await call('/api/orders', { method: 'POST', token: s.token, body: { items: [{ id: 'nandini', quantity: 1 }], address: PATNA } })).data
    await call(`/api/admin/orders/${order.id}`, { method: 'PATCH', token: admin.token, body: { status: 'Packed' } })
    const notes = (await call('/api/notifications', { token: s.token })).data
    assert.ok(notes.some((n) => n.body?.includes(order.id)))
  })
})

describe('riders', () => {
  test('a new rider is unapproved and blocked until an admin approves', async () => {
    const phone = `9${String(Date.now()).slice(-9)}`
    const rider = await login(phone, 'rider')
    assert.equal(rider.user.approved, false)
    assert.equal((await call('/api/rider/deliveries', { token: rider.token })).status, 403)

    const riders = (await call('/api/admin/riders', { token: admin.token })).data
    const pending = riders.find((r) => r.mobile.includes(phone.slice(-10)))
    await call(`/api/admin/riders/${pending.id}/approve`, { method: 'POST', token: admin.token, body: { approved: true } })
    assert.equal((await call('/api/rider/deliveries', { token: rider.token })).status, 200)
  })

  test('orders route to the customer assigned partner', async () => {
    const customers = (await call('/api/admin/customers', { token: admin.token })).data
    const aarav = customers.find((c) => c.name === 'Aarav Sharma')
    assert.ok(aarav.assignedRiderName, 'demo customer should have a partner')

    const s = await login('9876543210')
    const order = (await call('/api/orders', { method: 'POST', token: s.token, body: { items: [{ id: 'nandini', quantity: 1 }], address: PATNA } })).data
    const listed = (await call('/api/admin/orders?limit=200', { token: admin.token })).data.items.find((o) => o.id === order.id)
    assert.equal(listed.rider, aarav.assignedRiderName)
  })
})

describe('admin', () => {
  test('orders are paginated', async () => {
    const page = await call('/api/admin/orders?limit=2', { token: admin.token })
    assert.ok(Array.isArray(page.data.items))
    assert.ok(page.data.items.length <= 2)
    assert.equal(typeof page.data.total, 'number')
  })

  test('a product added by admin shows up for the app', async () => {
    const id = `test-item-${Date.now()}`
    await call('/api/admin/products', { method: 'POST', token: admin.token, body: { id, name: 'Test Item', price: 10 } })
    const catalog = (await call('/api/products')).data
    assert.ok(catalog.some((p) => p.id === id))
    await call(`/api/admin/products/${id}`, { method: 'DELETE', token: admin.token })
    const after = (await call('/api/products')).data
    assert.ok(!after.some((p) => p.id === id))
  })

  test('admin endpoints require admin auth', async () => {
    const s = await login('9876543210')
    assert.equal((await call('/api/admin/orders', { token: s.token })).status, 401)
  })
})
