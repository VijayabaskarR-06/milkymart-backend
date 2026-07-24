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
    tbody.querySelectorAll('[data-recharge]').forEach((btn) => btn.addEventListener('click', () => openRecharge(parseInt(btn.dataset.recharge, 10))))
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
    $('#riderCount').textContent = riders.length
    tbody.innerHTML = riders.map((r) => `
      <tr>
        <td><div class="cust"><div class="avatar" style="background:#0f766e">${escapeHtml(r.initials)}</div><div class="cust-name">${escapeHtml(r.name)}</div></div></td>
        <td class="mono-cell">${escapeHtml(r.mobile)}</td>
        <td class="right"><strong class="num">${fmtNum(r.customers)}</strong></td>
        <td class="right"><strong class="num">${fmtNum(r.delivered)} / ${fmtNum(r.assigned)}</strong></td>
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
  } catch (e) {
    tbody.innerHTML = `<tr class="row-empty"><td colspan="5">${escapeHtml(e.message)}</td></tr>`
  }
}

async function loadProducts() {
  const grid = $('#productGrid')
  try {
    const products = await api('/products')
    const active = products.filter((p) => p.active)
    $('#productCount').textContent = active.length
    grid.innerHTML = active.map((p) => {
      const mono = (p.name.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase()
      return `
      <div class="product">
        <div class="product-thumb" style="background:#f8fafc; color:#0f172a">
          ${p.offer > 0 ? `<span class="offer-badge">${p.offer}% OFF</span>` : ''}
          ${escapeHtml(mono)}
        </div>
        <div class="product-body">
          <div class="product-name">${escapeHtml(p.name)}</div>
          <div class="product-desc">${escapeHtml(p.description || p.size || '')}</div>
          <div class="product-row">
            <div class="price-stack">
              <span class="product-price">₹${p.price}</span>
              ${p.offer > 0 ? `<span class="product-price-old">₹${p.mrp}</span>` : ''}
            </div>
            ${p.offer > 0 ? `<span class="pill pill-green">${p.offer}% off</span>` : `<span class="pill pill-slate">No offer</span>`}
          </div>
        </div>
      </div>`
    }).join('')
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`
  }
}

/* ---------------- Add product ---------------- */
const productModal = $('#productModal')
function openProductModal() { productModal.classList.add('open'); productModal.setAttribute('aria-hidden', 'false') }
function closeProductModal() { productModal.classList.remove('open'); productModal.setAttribute('aria-hidden', 'true') }
document.querySelector('#section-product .btn-primary')?.addEventListener('click', openProductModal)
productModal.querySelectorAll('[data-close-product]').forEach((el) => el.addEventListener('click', closeProductModal))

$('#productForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('#productError')
  err.hidden = true
  const f = e.target
  const body = {
    id: f.id.value.trim().toLowerCase().replace(/\s+/g, '-'),
    name: f.name.value.trim(),
    size: f.size.value.trim(),
    category: f.category.value.trim(),
    price: Number(f.price.value),
    mrp: f.mrp.value ? Number(f.mrp.value) : undefined,
    description: f.description.value.trim(),
  }
  try {
    // Upload the photo first (when storage is configured and a file was chosen).
    const file = f.photo?.files?.[0]
    if (file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('Could not read that image'))
        reader.readAsDataURL(file)
      })
      try {
        const uploaded = await api('/uploads/product-image', { method: 'POST', body: { dataUrl, name: body.id } })
        body.image = uploaded.url
      } catch (uploadErr) {
        // Without storage configured the product still saves with a stock image.
        toast(`${uploadErr.message} — saving without a photo`)
      }
    }
    await api('/products', { method: 'POST', body })
    closeProductModal()
    f.reset()
    toast(`${body.name} added — now live in the app`)
    loadProducts()
    loadOverview()
  } catch (e2) {
    err.textContent = e2.message
    err.hidden = false
  }
})

$('#refreshOrders')?.addEventListener('click', () => { loadOrders(); loadOverview(); toast('Refreshed') })

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
function openRecharge(idx) {
  const u = customersCache[idx]
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
            <div class="recharge-date">${escapeHtml(r.date)}</div>
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
})

/* ---------------- Boot ---------------- */
if (token) { showApp(); loadAll() } else { showLogin() }
