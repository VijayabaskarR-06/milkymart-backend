/* MilkyMart Admin — wired to the live backend API.
   Served from the backend at /admin, so the API is same-origin at /api/admin. */

const API = `${location.origin}/api/admin`
const TOKEN_KEY = 'mm-admin-token'
let token = localStorage.getItem(TOKEN_KEY)

const $ = (sel) => document.querySelector(sel)
const fmtNum = (n) => Number(n).toLocaleString('en-IN')
const fmtRupee = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    logout()
    throw new Error('Session expired — please sign in again')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function toast(message) {
  let el = $('.admin-toast')
  if (!el) {
    el = document.createElement('div')
    el.className = 'admin-toast'
    document.body.appendChild(el)
  }
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('show'), 2400)
}

/* ---------------- Auth gate ---------------- */
function showLogin() {
  $('#loginScreen').hidden = false
  $('#app').hidden = true
}
function showApp() {
  $('#loginScreen').hidden = true
  $('#app').hidden = false
}
function logout() {
  token = null
  localStorage.removeItem(TOKEN_KEY)
  showLogin()
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('#loginError')
  err.hidden = true
  try {
    const { token: t, admin } = await api('/login', {
      method: 'POST',
      body: { email: $('#loginEmail').value, password: $('#loginPassword').value },
    })
    token = t
    localStorage.setItem(TOKEN_KEY, t)
    if (admin?.name) {
      $('#adminName').textContent = admin.name
      $('#adminAvatar').textContent = admin.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
    }
    showApp()
    loadAll()
  } catch (e2) {
    err.textContent = e2.message
    err.hidden = false
  }
})

$('#logoutBtn')?.addEventListener('click', logout)

/* ---------------- Change password ---------------- */
const passwordModal = $('#passwordModal')
const passwordForm = $('#passwordForm')
function openPasswordModal() {
  passwordForm.reset()
  $('#passwordError').hidden = true
  passwordModal.classList.add('open')
  passwordModal.setAttribute('aria-hidden', 'false')
}
function closePasswordModal() {
  passwordModal.classList.remove('open')
  passwordModal.setAttribute('aria-hidden', 'true')
}
$('#changePasswordBtn')?.addEventListener('click', openPasswordModal)
passwordModal.querySelectorAll('[data-close-password]').forEach((el) => el.addEventListener('click', closePasswordModal))

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('#passwordError')
  err.hidden = true
  const f = e.target
  const currentPassword = f.currentPassword.value
  const newPassword = f.newPassword.value
  const confirmPassword = f.confirmPassword.value
  if (newPassword !== confirmPassword) {
    err.textContent = 'New password and confirmation do not match'
    err.hidden = false
    return
  }
  try {
    const { token: t } = await api('/change-password', { method: 'POST', body: { currentPassword, newPassword } })
    // The server just invalidated every other admin session — including the
    // token this tab was using — so swap in the fresh one it hands back.
    token = t
    localStorage.setItem(TOKEN_KEY, t)
    closePasswordModal()
    toast('Password updated — you have been signed out everywhere else')
  } catch (e2) {
    err.textContent = e2.message
    err.hidden = false
  }
})

/* ---------------- Navigation ---------------- */
const navItems = document.querySelectorAll('.nav-item[data-section]')
const sections = document.querySelectorAll('.section')
const crumb = $('#crumbTitle')

navItems.forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault()
    const id = item.dataset.section
    navItems.forEach((n) => n.classList.remove('active'))
    item.classList.add('active')
    sections.forEach((s) => s.classList.remove('active'))
    document.getElementById(`section-${id}`).classList.add('active')
    if (crumb) crumb.textContent = item.querySelector('.nav-label').textContent
    if (window.innerWidth <= 820) closeSidebar()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
})

/* ---------------- Sidebar toggle ---------------- */
const appEl = $('#app')
const sidebar = $('#sidebar')
const overlay = $('#sidebarOverlay')
const collapseBtn = $('#collapseBtn')
const isMobile = () => window.innerWidth <= 820
function openSidebar() { sidebar.classList.add('open'); overlay.classList.add('open') }
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('open') }
collapseBtn.addEventListener('click', () => {
  if (isMobile()) sidebar.classList.contains('open') ? closeSidebar() : openSidebar()
  else appEl.classList.toggle('collapsed')
})
overlay.addEventListener('click', closeSidebar)

/* ---------------- Data loading ---------------- */
let customersCache = []
let ridersCache = []

async function loadAll() {
  await Promise.all([loadOverview(), loadOrders(), loadCustomers(), loadRiders(), loadProducts()])
}

async function loadOverview() {
  try {
    const { kpis } = await api('/overview')
    const cards = [
      { label: 'Total orders', value: kpis.totalOrders, tag: 'All time', trend: { dir: 'up', text: fmtRupee(kpis.revenue), sub: 'total revenue' }, icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 2L3 6V20A2 2 0 005 22H19A2 2 0 0021 20V6L18 2H6ZM3 6H21M16 10A4 4 0 018 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
      { label: 'Active orders', value: kpis.activeOrders, tag: 'In progress', trend: { dir: 'amber', text: String(kpis.activeOrders), sub: 'awaiting delivery' }, icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8V12L15 14M21 12A9 9 0 113 12A9 9 0 0121 12Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
      { label: 'Delivered orders', value: kpis.deliveredOrders, tag: 'Completed', trend: { dir: 'up', text: `${kpis.customers}`, sub: 'customers served' }, icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    ]
    document.querySelectorAll('[data-stats="orders"]').forEach((container) => {
      container.innerHTML = cards.map((s) => `
        <div class="stat-card">
          <div class="stat-top"><div class="stat-icon">${s.icon}</div><span class="stat-tag">${s.tag}</span></div>
          <div class="stat-label">${s.label}</div>
          <div class="stat-value">${fmtNum(s.value)}</div>
          <div class="stat-trend ${s.trend.dir}"><strong>${escapeHtml(s.trend.text)}</strong> ${s.trend.sub}</div>
        </div>`).join('')
    })
  } catch (e) { console.error(e) }
}

const STATUSES = ['Confirmed', 'Packed', 'Out for delivery', 'Delivered', 'Cancelled']

async function loadOrders() {
  const tbody = $('#orderTable')
  try {
    // The endpoint is paginated: { items, total, limit, offset }.
    const page = await api('/orders?limit=100')
    const orders = Array.isArray(page) ? page : page.items || []
    const totalCount = Array.isArray(page) ? page.length : page.total ?? orders.length
    const countLabel = document.querySelector('#section-order .muted')
    if (countLabel) {
      countLabel.textContent =
        totalCount > orders.length
          ? `Showing ${orders.length} of ${totalCount} orders — change a status and the customer is notified instantly.`
          : 'Live orders from the Milky Mart app — change a status and the customer is notified instantly.'
    }
    if (!orders.length) {
      tbody.innerHTML = '<tr class="row-empty"><td colspan="5">No orders yet.</td></tr>'
      return
    }
    tbody.innerHTML = orders.map((o) => `
      <tr>
        <td><span class="order-id">#${escapeHtml(o.id)}</span><div class="muted" style="font-size:11px">${escapeHtml(o.date)}</div></td>
        <td>${escapeHtml(o.customer)}</td>
        <td><div class="order-items">${escapeHtml((o.items || []).join(', ') || '—')}</div></td>
        <td class="right"><strong class="num">${fmtRupee(o.total)}</strong></td>
        <td>
          <select class="status-select status-${o.status.replace(/\s+/g, '')}" data-order="${escapeHtml(o.id)}">
            ${STATUSES.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </td>
      </tr>`).join('')

    tbody.querySelectorAll('.status-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.order
        try {
          await api(`/orders/${id}`, { method: 'PATCH', body: { status: sel.value } })
          sel.className = `status-select status-${sel.value.replace(/\s+/g, '')}`
          toast(`Order #${id} → ${sel.value}. Customer notified.`)
          loadOverview()
        } catch (e) {
          // e.g. an order can't go backwards — show why and restore the real value
          toast(e.message)
          loadOrders()
        }
      })
    })
  } catch (e) {
    tbody.innerHTML = `<tr class="row-empty"><td colspan="5">${escapeHtml(e.message)}</td></tr>`
  }
}

let approvedRidersCache = []

async function loadCustomers() {
  const tbody = $('#userTable')
  try {
    // Load customers and the approved-rider list together for the partner dropdown.
    const [users, riders] = await Promise.all([api('/customers'), api('/riders')])
    customersCache = users
    approvedRidersCache = riders.filter((r) => r.approved)
    $('#userCount').textContent = users.length
    const options = (selectedId) =>
      `<option value="">Unassigned</option>` +
      approvedRidersCache
        .map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`)
        .join('')
    tbody.innerHTML = users.map((u, i) => `
      <tr>
        <td><div class="cust"><div class="avatar" style="background:#1e293b">${escapeHtml(u.initials)}</div><div class="cust-name">${escapeHtml(u.name)}</div></div></td>
        <td class="mono-cell">${escapeHtml(u.mobile)}</td>
        <td><select class="partner-select" data-customer="${u.id}">${options(u.assignedRiderId)}</select></td>
        <td class="right"><span class="balance num ${u.wallet < 200 ? 'low' : ''}">${fmtRupee(u.wallet)}</span> <button class="btn-link" data-addmoney="${u.id}" data-name="${escapeHtml(u.name)}">+ Add</button></td>
        <td class="right"><button class="btn-link" data-orders="${u.id}">View (${u.orders})</button></td>
        <td class="right"><button class="btn-link" data-recharge="${i}">View (${u.recharges.length})</button></td>
      </tr>`).join('')
    tbody.querySelectorAll('[data-addmoney]').forEach((btn) => btn.addEventListener('click', () => addCustomerMoney(btn.dataset.addmoney, btn.dataset.name)))
    tbody.querySelectorAll('[data-recharge]').forEach((btn) => btn.addEventListener('click', () => openRecharge(parseInt(btn.dataset.recharge, 10), 'customer')))
    tbody.querySelectorAll('[data-orders]').forEach((btn) => btn.addEventListener('click', () => openCustomerOrders(btn.dataset.orders)))
    tbody.querySelectorAll('.partner-select').forEach((sel) =>
      sel.addEventListener('change', async () => {
        try {
          await api(`/customers/${sel.dataset.customer}/assign-rider`, {
            method: 'POST',
            body: { riderId: sel.value ? Number(sel.value) : null },
          })
          toast(sel.value ? 'Delivery partner assigned' : 'Delivery partner cleared')
          loadRiders()
        } catch (e) {
          toast(e.message)
          loadCustomers()
        }
      }),
    )
  } catch (e) {
    tbody.innerHTML = `<tr class="row-empty"><td colspan="5">${escapeHtml(e.message)}</td></tr>`
  }
}

async function loadRiders() {
  const tbody = $('#riderTable')
  try {
    const riders = await api('/riders')
    ridersCache = riders
    $('#riderCount').textContent = riders.length
    tbody.innerHTML = riders.map((r, i) => `
      <tr>
        <td><div class="cust"><div class="avatar" style="background:#0f766e">${escapeHtml(r.initials)}</div><div class="cust-name">${escapeHtml(r.name)}</div></div></td>
        <td class="mono-cell">${escapeHtml(r.mobile)}</td>
        <td class="right"><strong class="num">${fmtNum(r.customers)}</strong></td>
        <td class="right"><strong class="num">${fmtNum(r.delivered)} / ${fmtNum(r.assigned)}</strong></td>
        <td class="right"><span class="balance num">${fmtRupee(r.wallet)}</span> <button class="btn-link" data-rider-recharge="${i}">View (${r.recharges.length})</button></td>
        <td>
          ${r.approved
            ? `<span class="rider-badge approved">Approved</span>`
            : `<button class="btn btn-primary btn-approve" data-approve="${r.id}">Approve</button>`}
        </td>
      </tr>`).join('')
    tbody.querySelectorAll('[data-approve]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await api(`/riders/${btn.dataset.approve}/approve`, { method: 'POST', body: { approved: true } })
          toast('Rider approved — you can now assign them to customers')
          loadRiders()
          loadCustomers()
        } catch (e) {
          toast(e.message)
        }
      }),
    )
    tbody.querySelectorAll('[data-rider-recharge]').forEach((btn) => btn.addEventListener('click', () => openRecharge(parseInt(btn.dataset.riderRecharge, 10), 'rider')))
  } catch (e) {
    tbody.innerHTML = `<tr class="row-empty"><td colspan="6">${escapeHtml(e.message)}</td></tr>`
  }
}

// Products the owner can act on, keyed by id so the edit form can be filled
// from the last load without another round trip.
const productsById = new Map()

async function loadProducts() {
  const grid = $('#productGrid')
  try {
    const products = await api('/products')
    productsById.clear()
    products.forEach((p) => productsById.set(p.id, p))

    // Hidden (deactivated) products stay listed behind a toggle — otherwise
    // deactivating one would make it unreachable and impossible to restore.
    const showHidden = $('#showHidden')?.checked
    const visible = showHidden ? products : products.filter((p) => p.active)
    $('#productCount').textContent = products.filter((p) => p.active).length

    if (!visible.length) {
      grid.innerHTML = `<p class="muted">No products yet. Use “Add product” to create the first one.</p>`
      return
    }

    grid.innerHTML = visible.map((p) => {
      const mono = (p.name.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase()
      // A product image may be a CDN URL or one of the paths bundled with the
      // app; the latter cannot resolve here, so fall back to the initials.
      const thumb = p.image && /^https?:\/\//.test(p.image)
        ? `<img src="${escapeHtml(p.image)}" alt="" onerror="this.remove()" />`
        : escapeHtml(mono)
      return `
      <button class="product product-editable${p.active ? '' : ' product-hidden'}" data-edit-product="${escapeHtml(p.id)}" type="button">
        <div class="product-thumb" style="background:#f8fafc; color:#0f172a">
          ${p.offer > 0 ? `<span class="offer-badge">${p.offer}% OFF</span>` : ''}
          ${thumb}
        </div>
        <div class="product-body">
          <div class="product-name">${escapeHtml(p.name)}</div>
          <div class="product-desc">${escapeHtml(p.description || p.size || '')}</div>
          <div class="product-row">
            <div class="price-stack">
              <span class="product-price">₹${p.price}</span>
              ${p.offer > 0 ? `<span class="product-price-old">₹${p.mrp}</span>` : ''}
            </div>
            ${p.active
              ? (p.offer > 0 ? `<span class="pill pill-green">${p.offer}% off</span>` : `<span class="pill pill-slate">No offer</span>`)
              : `<span class="pill pill-slate">Hidden</span>`}
          </div>
          <span class="product-edit-hint">Edit</span>
        </div>
      </button>`
    }).join('')
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`
  }
}

$('#showHidden')?.addEventListener('change', loadProducts)

// Clicking a card edits it. Delegated so it survives every re-render.
$('#productGrid')?.addEventListener('click', (e) => {
  const card = e.target.closest('[data-edit-product]')
  if (card) openProductModal(productsById.get(card.dataset.editProduct))
})

/* ---------------- Add / edit product ---------------- */
const productModal = $('#productModal')
// null = creating, otherwise the id of the product being edited.
let editingProductId = null

function openProductModal(product = null) {
  const f = $('#productForm')
  const err = $('#productError')
  err.hidden = true
  f.reset()
  editingProductId = product?.id ?? null

  $('#productModalTitle').textContent = product ? 'Edit product' : 'Add product'
  $('#productModalHint').textContent = product
    ? 'Changes reach the app the next time it syncs.'
    : 'New products appear in the app instantly.'
  $('#productSubmit').textContent = product ? 'Save changes' : 'Save product'
  // The id is the primary key and is referenced by past orders, so it is fixed
  // once the product exists.
  f.id.readOnly = Boolean(product)
  $('#activeRow').hidden = !product

  const photo = $('#currentPhoto')
  const photoImg = $('#currentPhotoImg')
  const hasRemoteImage = product?.image && /^https?:\/\//.test(product.image)
  photo.hidden = !hasRemoteImage
  photoImg.src = hasRemoteImage ? product.image : ''

  if (product) {
    f.name.value = product.name ?? ''
    f.id.value = product.id
    f.size.value = product.size ?? ''
    f.category.value = product.category ?? ''
    f.price.value = product.price ?? ''
    f.mrp.value = product.mrp ?? ''
    f.badge.value = product.badge ?? ''
    f.stock.value = product.stock ?? ''
    f.description.value = product.description ?? ''
    f.active.checked = product.active !== false
  }

  productModal.classList.add('open')
  productModal.setAttribute('aria-hidden', 'false')
}

function closeProductModal() {
  productModal.classList.remove('open')
  productModal.setAttribute('aria-hidden', 'true')
  editingProductId = null
}

$('#addProductBtn')?.addEventListener('click', () => openProductModal())
productModal.querySelectorAll('[data-close-product]').forEach((el) => el.addEventListener('click', closeProductModal))

// Reads the chosen file and pushes it to storage.
// Returns {} when no file was picked, {url} on success, or {error} when the
// upload failed — the caller saves the other fields either way, but a failure
// has to be reported rather than swallowed: the owner asked for a new photo and
// would otherwise be told the product saved and assume the picture changed too.
async function uploadChosenPhoto(fileInput, idForName) {
  const file = fileInput?.files?.[0]
  if (!file) return {}
  let dataUrl
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('Could not read that image'))
      reader.readAsDataURL(file)
    })
  } catch (readErr) {
    return { error: readErr.message }
  }
  try {
    const uploaded = await api('/uploads/product-image', { method: 'POST', body: { dataUrl, name: idForName } })
    return { url: uploaded.url }
  } catch (uploadErr) {
    return { error: uploadErr.message }
  }
}

$('#productForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('#productError')
  err.hidden = true
  const f = e.target
  const submit = $('#productSubmit')
  const wasEditing = editingProductId
  const id = wasEditing || f.id.value.trim().toLowerCase().replace(/\s+/g, '-')

  const body = {
    name: f.name.value.trim(),
    size: f.size.value.trim(),
    category: f.category.value.trim(),
    price: Number(f.price.value),
    // Blank MRP means "no offer": send the price so the app shows no fake discount.
    mrp: f.mrp.value ? Number(f.mrp.value) : Number(f.price.value),
    badge: f.badge.value.trim() || null,
    description: f.description.value.trim(),
  }
  if (f.stock.value !== '') body.stock = Number(f.stock.value)

  submit.disabled = true
  try {
    const photo = await uploadChosenPhoto(f.photo, id)
    if (photo.url) body.image = photo.url

    if (wasEditing) {
      body.active = f.active.checked
      await api(`/products/${encodeURIComponent(wasEditing)}`, { method: 'PATCH', body })
    } else {
      await api('/products', { method: 'POST', body: { ...body, id } })
    }
    loadProducts()
    loadOverview()

    if (photo.error) {
      // Everything except the picture saved. Keep the dialog open and say so
      // inline, because a toast here is immediately replaced and missed.
      f.photo.value = ''
      err.textContent = `${body.name} saved, but the photo was not changed — ${photo.error}`
      err.hidden = false
      return
    }

    closeProductModal()
    f.reset()
    toast(wasEditing ? `${body.name} updated` : `${body.name} added — now live in the app`)
  } catch (e2) {
    err.textContent = e2.message
    err.hidden = false
  } finally {
    submit.disabled = false
  }
})

$('#refreshOrders')?.addEventListener('click', () => { loadOrders(); loadOverview(); toast('Refreshed') })

/* ---------------- Activity (audit log) ---------------- */
const ACTION_LABELS = {
  'admin.password_changed': 'Changed admin password',
  'demo.reset': 'Reset demo data',
  'order.status_changed': 'Changed order status',
  'product.created': 'Added product',
  'product.updated': 'Edited product',
  'product.deleted': 'Removed product',
  'customer.wallet_adjusted': "Adjusted customer's wallet",
  'customer.rider_assigned': 'Assigned delivery partner',
  'rider.approved': 'Approved rider',
  'rider.revoked': 'Revoked rider approval',
}
function describeActivity(a) {
  const label = ACTION_LABELS[a.action] || a.action
  const m = a.meta || {}
  if (a.action === 'order.status_changed') return `Order #${a.targetId}: ${m.from} → ${m.to}`
  if (a.action === 'customer.wallet_adjusted') return `Customer #${a.targetId}: ${m.amount > 0 ? '+' : ''}₹${m.amount} (${m.note || ''})`
  if (a.action === 'customer.rider_assigned') return `Customer #${a.targetId} → rider ${m.riderId ?? 'unassigned'}`
  if (a.targetType && a.targetId) return `${a.targetType} #${a.targetId}`
  return label
}
let activityLoaded = false
async function loadActivity() {
  const tbody = $('#activityTable')
  try {
    const rows = await api('/audit-log?limit=200')
    activityLoaded = true
    if (!rows.length) {
      tbody.innerHTML = '<tr class="row-empty"><td colspan="4">No admin activity recorded yet.</td></tr>'
      return
    }
    tbody.innerHTML = rows.map((a) => `
      <tr>
        <td class="mono-cell">${escapeHtml(a.date)}</td>
        <td>${escapeHtml(a.admin || '—')}</td>
        <td>${escapeHtml(ACTION_LABELS[a.action] || a.action)}</td>
        <td class="muted">${escapeHtml(describeActivity(a))}</td>
      </tr>`).join('')
  } catch (e) {
    tbody.innerHTML = `<tr class="row-empty"><td colspan="4">${escapeHtml(e.message)}</td></tr>`
  }
}
document.querySelector('.nav-item[data-section="activity"]')?.addEventListener('click', () => { if (!activityLoaded) loadActivity() })
$('#refreshActivity')?.addEventListener('click', () => { loadActivity(); toast('Refreshed') })

// The "Add user/rider" buttons are informational in this demo.
document.querySelectorAll('#section-user .btn-primary, #section-rider .btn-primary').forEach((btn) =>
  btn.addEventListener('click', () => toast('Users and riders are created when they sign in to the app.')))

/* ---------------- Customer order history ---------------- */
const ordersModal = $('#ordersModal')

async function openCustomerOrders(customerId) {
  $('#ordersTitle').textContent = 'Order history'
  $('#ordersSub').textContent = 'Loading…'
  $('#ordersBody').innerHTML = '<p class="muted">Loading orders…</p>'
  ordersModal.classList.add('open')
  ordersModal.setAttribute('aria-hidden', 'false')
  try {
    const { customer, orders, summary } = await api(`/customers/${customerId}/orders`)
    $('#ordersTitle').textContent = `${customer.name}'s orders`
    $('#ordersSub').textContent =
      `${summary.count} orders · ${fmtRupee(summary.spent)} lifetime · ${summary.delivered} delivered · ${summary.active} active · wallet ${fmtRupee(customer.wallet)}`
    if (!orders.length) {
      $('#ordersBody').innerHTML = '<p class="muted">This customer hasn\'t placed any orders yet.</p>'
      return
    }
    $('#ordersBody').innerHTML = `
      <table class="table table-tight">
        <thead><tr><th>Order</th><th>Items</th><th>Partner</th><th class="right">Total</th><th>Status</th></tr></thead>
        <tbody>
          ${orders.map((o) => `
            <tr>
              <td><span class="order-id">#${escapeHtml(o.id)}</span><div class="muted" style="font-size:11px">${escapeHtml(o.date)}</div></td>
              <td><div class="order-items">${escapeHtml((o.items || []).join(', ') || '—')}</div>
                  <div class="muted" style="font-size:11px">${escapeHtml(o.payment || '')}</div></td>
              <td>${escapeHtml(o.rider || '—')}</td>
              <td class="right"><strong class="num">${fmtRupee(o.total)}</strong></td>
              <td><span class="status-pill status-${o.status.replace(/\s+/g, '')}">${escapeHtml(o.status)}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>`
  } catch (e) {
    $('#ordersBody').innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`
  }
}

function closeOrdersModal() {
  ordersModal.classList.remove('open')
  ordersModal.setAttribute('aria-hidden', 'true')
}
ordersModal.querySelectorAll('[data-close-orders]').forEach((el) => el.addEventListener('click', closeOrdersModal))

/* ---------------- Add money to a customer's wallet ---------------- */
async function addCustomerMoney(customerId, name) {
  const input = window.prompt(`Add money to ${name}'s wallet\n\nEnter the cash amount collected by the delivery partner (₹):`, '')
  if (input === null) return
  const amount = Math.round(Number(input))
  if (!Number.isFinite(amount) || amount <= 0) { toast('Enter a valid amount'); return }
  try {
    const res = await api(`/customers/${customerId}/wallet`, { method: 'POST', body: { amount } })
    toast(`₹${amount} added · new balance ₹${Number(res.wallet).toLocaleString('en-IN')}`)
    loadCustomers()
  } catch (e) {
    toast(e.message)
  }
}

/* ---------------- Recharge modal ---------------- */
const modal = $('#rechargeModal')
function openRecharge(idx, source = 'customer') {
  const u = (source === 'rider' ? ridersCache : customersCache)[idx]
  if (!u) return
  const total = u.recharges.reduce((s, r) => s + (r.type === 'debit' ? -r.amount : r.amount), 0)
  $('#modalTitle').textContent = `${u.name}'s wallet activity`
  $('#modalSub').textContent = `${u.recharges.length} recent · net ₹${total.toLocaleString('en-IN')}`
  $('#modalBody').innerHTML = `
    <ul class="recharge-list">
      ${u.recharges.map((r) => `
        <li>
          <div class="recharge-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12L12 19L19 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="rotate(${r.mode === 'Debit' ? 0 : 180} 12 12)"/></svg></div>
          <div class="recharge-meta">
            <div class="recharge-amount">${r.mode === 'Debit' ? '−' : '+'} ₹${r.amount.toLocaleString('en-IN')}</div>
            <div class="recharge-date">${escapeHtml(r.label || '')} · ${escapeHtml(r.date)}</div>
          </div>
          <span class="recharge-mode">${escapeHtml(r.mode)}</span>
        </li>`).join('')}
    </ul>`
  modal.classList.add('open')
  modal.setAttribute('aria-hidden', 'false')
}
function closeModal() { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true') }
modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal))
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (modal.classList.contains('open')) closeModal()
  if (productModal.classList.contains('open')) closeProductModal()
  if (ordersModal.classList.contains('open')) closeOrdersModal()
  if (passwordModal.classList.contains('open')) closePasswordModal()
})

/* ---------------- Boot ---------------- */
if (token) { showApp(); loadAll() } else { showLogin() }
