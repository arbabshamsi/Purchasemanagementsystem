'use strict';

/* ============================================================
   Purchase Management System — single-page frontend
   ============================================================ */

const State = {
  user: null,
  companies: [],
};

/* ---------- API helper ---------- */
async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Small utilities ---------- */
function $(sel, root = document) { return root.querySelector(sel); }
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n, currency = 'PKR') {
  const v = Number(n || 0);
  return `${currency} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return esc(s);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return esc(s);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function badge(status) { return `<span class="badge ${esc(status)}">${esc(status)}</span>`; }
function can(...roles) { return State.user && (State.user.role === 'admin' || roles.includes(State.user.role)); }

function toast(title, msg = '', type = 'success') {
  const t = h(`<div class="toast ${type}"><div class="toast-title">${esc(title)}</div>${msg ? `<div class="toast-msg">${esc(msg)}</div>` : ''}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
}

/* ---------- Modal ---------- */
function openModal(innerHtml, { wide = false } = {}) {
  const host = $('#modal-host');
  const modal = $('#modal');
  modal.className = 'modal' + (wide ? ' wide' : '');
  modal.innerHTML = innerHtml;
  host.classList.remove('hidden');
  $('.modal-backdrop', host).onclick = closeModal;
  const first = modal.querySelector('input, select, textarea, button');
  if (first) setTimeout(() => first.focus(), 30);
  return modal;
}
function closeModal() { $('#modal-host').classList.add('hidden'); $('#modal').innerHTML = ''; }

/* ---------- Auth ---------- */
async function doLogin(e) {
  e.preventDefault();
  const form = e.target;
  const errEl = $('#login-error');
  errEl.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const body = { email: form.email.value.trim(), password: form.password.value };
    const { user } = await api('/auth/login', { method: 'POST', body });
    State.user = user;
    await bootApp();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function doLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
  State.user = null;
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}

/* ---------- Navigation ---------- */
const NAV = [
  { hash: '#/dashboard', label: 'Dashboard', icon: '📊' },
  { hash: '#/purchase-orders', label: 'Purchase Orders', icon: '📝', badgeKey: 'pending' },
  { hash: '#/rate-lists', label: 'Rate Lists', icon: '📋' },
  { hash: '#/suppliers', label: 'Suppliers', icon: '🏭' },
  { hash: '#/items', label: 'Items', icon: '📦' },
  { hash: '#/users', label: 'Users', icon: '👥', role: 'admin' },
];

async function renderNav() {
  let pendingCount = 0;
  try {
    const { byStatus } = await api('/purchase-orders/summary');
    const p = byStatus.find((s) => s.status === 'pending');
    pendingCount = p ? p.n : 0;
  } catch (_) {}

  const nav = $('#nav');
  nav.innerHTML = '';
  for (const item of NAV) {
    if (item.role && !can(item.role)) continue;
    const badgeHtml = item.badgeKey === 'pending' && pendingCount
      ? `<span class="nav-badge">${pendingCount}</span>` : '';
    const a = h(`<a href="${item.hash}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span>${badgeHtml}</a>`);
    nav.appendChild(a);
  }
  $('#user-box').innerHTML =
    `<div class="user-name">${esc(State.user.name)}</div><div class="user-role">${esc(State.user.role)}</div>`;
  highlightNav();
}
function highlightNav() {
  const current = location.hash.split('/').slice(0, 2).join('/');
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === current);
  });
}

/* ---------- Router ---------- */
const routes = [];
function route(pattern, handler) { routes.push({ pattern, handler }); }

route(/^#\/dashboard$/, viewDashboard);
route(/^#\/purchase-orders$/, viewPurchaseOrders);
route(/^#\/purchase-orders\/new$/, () => viewPoForm(null));
route(/^#\/purchase-orders\/(\d+)\/edit$/, (m) => viewPoForm(m[1]));
route(/^#\/purchase-orders\/(\d+)$/, (m) => viewPoDetail(m[1]));
route(/^#\/rate-lists$/, viewRateLists);
route(/^#\/rate-lists\/upload$/, viewRateListUpload);
route(/^#\/rate-lists\/(\d+)$/, (m) => viewRateListDetail(m[1]));
route(/^#\/suppliers$/, viewSuppliers);
route(/^#\/items$/, viewItems);
route(/^#\/users$/, viewUsers);

function setPage(title, actionsHtml = '') {
  $('#page-title').textContent = title;
  $('#topbar-actions').innerHTML = actionsHtml;
}
function loading() { $('#view').innerHTML = '<div class="spinner">Loading…</div>'; }
function render(html) { $('#view').innerHTML = ''; $('#view').appendChild(typeof html === 'string' ? h(`<div>${html}</div>`) : html); }
function renderRaw(html) { $('#view').innerHTML = html; }

async function router() {
  if (!State.user) return;
  const hash = location.hash || '#/dashboard';
  closeSidebar();
  highlightNav();
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      try { await r.handler(m); }
      catch (err) { renderRaw(`<div class="empty"><div class="empty-icon">⚠️</div><p>${esc(err.message)}</p></div>`); }
      return;
    }
  }
  location.hash = '#/dashboard';
}

/* ============================================================
   VIEWS
   ============================================================ */

/* ---------- Dashboard ---------- */
async function viewDashboard() {
  setPage('Dashboard');
  loading();
  const [{ byStatus, byCompany }, { purchaseOrders }] = await Promise.all([
    api('/purchase-orders/summary'),
    api('/purchase-orders'),
  ]);
  const statusMap = Object.fromEntries(byStatus.map((s) => [s.status, s.n]));
  const recent = purchaseOrders.slice(0, 8);

  const stats = `
    <div class="grid grid-4">
      <div class="stat accent-warning"><div class="stat-label">Pending approval</div><div class="stat-value">${statusMap.pending || 0}</div><div class="stat-hint">awaiting a decision</div></div>
      <div class="stat accent-success"><div class="stat-label">Approved</div><div class="stat-value">${statusMap.approved || 0}</div><div class="stat-hint">ready to purchase</div></div>
      <div class="stat accent-primary"><div class="stat-label">Drafts</div><div class="stat-value">${statusMap.draft || 0}</div><div class="stat-hint">not yet submitted</div></div>
      <div class="stat accent-info"><div class="stat-label">Rejected</div><div class="stat-value">${statusMap.rejected || 0}</div><div class="stat-hint">needs revision</div></div>
    </div>`;

  const companyCards = byCompany.map((c) => `
    <div class="card">
      <h3>${esc(c.company)} <span class="badge company">${esc(c.code)}</span></h3>
      <p class="card-sub">${c.total} purchase orders in total</p>
      <div class="grid grid-3">
        <div><div class="text-muted">Pending</div><div style="font-size:22px;font-weight:700;color:var(--warning)">${c.pending}</div></div>
        <div><div class="text-muted">Approved</div><div style="font-size:22px;font-weight:700;color:var(--success)">${c.approved}</div></div>
        <div><div class="text-muted">Approved value</div><div style="font-size:18px;font-weight:700">${money(c.approved_value)}</div></div>
      </div>
    </div>`).join('');

  const recentRows = recent.length ? recent.map((po) => `
    <tr class="clickable" data-href="#/purchase-orders/${po.id}">
      <td><strong>${esc(po.po_number)}</strong></td>
      <td><span class="badge company">${esc(po.company_code)}</span></td>
      <td>${esc(po.supplier_name)}</td>
      <td>${badge(po.status)}</td>
      <td class="text-right num">${money(po.total, po.currency)}</td>
      <td class="text-muted">${fmtDate(po.created_at)}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:24px">No purchase orders yet</td></tr>';

  renderRaw(`
    ${stats}
    <div class="grid grid-2" style="margin-top:20px">${companyCards}</div>
    <div class="card">
      <h3>Recent purchase orders</h3>
      <p class="card-sub">Latest activity across both companies</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>PO #</th><th>Company</th><th>Supplier</th><th>Status</th><th class="text-right">Total</th><th>Created</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>
    </div>`);
  wireRowLinks();
}

/* ---------- Purchase Orders list ---------- */
async function viewPurchaseOrders() {
  const actions = can('staff', 'approver')
    ? `<a class="btn btn-primary" href="#/purchase-orders/new">+ New Purchase Order</a>` : '';
  setPage('Purchase Orders', actions);
  loading();
  const [{ companies }, { purchaseOrders }] = await Promise.all([
    api('/companies'),
    api('/purchase-orders'),
  ]);
  State.companies = companies;

  const filters = `
    <div class="filters">
      <select id="f-company"><option value="">All companies</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <select id="f-status"><option value="">All statuses</option>${['draft', 'pending', 'approved', 'rejected', 'cancelled'].map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
    </div>`;

  renderRaw(`${filters}<div id="po-table"></div>`);
  const draw = (list) => {
    const rows = list.length ? list.map((po) => `
      <tr class="clickable" data-href="#/purchase-orders/${po.id}">
        <td><strong>${esc(po.po_number)}</strong></td>
        <td><span class="badge company">${esc(po.company_code)}</span></td>
        <td>${esc(po.supplier_name)}</td>
        <td>${badge(po.status)}</td>
        <td class="text-right num">${money(po.total, po.currency)}</td>
        <td class="text-muted">${esc(po.created_by_name || '—')}</td>
        <td class="text-muted">${fmtDate(po.created_at)}</td>
      </tr>`).join('')
      : '<tr><td colspan="7" class="empty">No purchase orders match</td></tr>';
    $('#po-table').innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>PO #</th><th>Company</th><th>Supplier</th><th>Status</th><th class="text-right">Total</th><th>Created by</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    wireRowLinks();
  };
  draw(purchaseOrders);

  const applyFilters = async () => {
    const params = new URLSearchParams();
    if ($('#f-company').value) params.set('company_id', $('#f-company').value);
    if ($('#f-status').value) params.set('status', $('#f-status').value);
    const { purchaseOrders: list } = await api(`/purchase-orders?${params.toString()}`);
    draw(list);
  };
  $('#f-company').onchange = applyFilters;
  $('#f-status').onchange = applyFilters;
}

/* ---------- Purchase Order create / edit ---------- */
async function viewPoForm(poId) {
  setPage(poId ? 'Edit Purchase Order' : 'New Purchase Order');
  loading();
  const [{ companies }, { suppliers }] = await Promise.all([
    api('/companies'),
    api('/suppliers'),
  ]);
  let po = null;
  if (poId) {
    const r = await api(`/purchase-orders/${poId}`);
    po = r.purchaseOrder;
    if (po.status !== 'draft') { location.hash = `#/purchase-orders/${poId}`; return; }
  }

  const activeSuppliers = suppliers.filter((s) => s.active || (po && s.id === po.supplier_id));
  const supplierOpts = (sel) => activeSuppliers.map((s) => `<option value="${s.id}" ${sel == s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const companyOpts = (sel) => companies.map((c) => `<option value="${c.id}" ${sel == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  renderRaw(`
    <div class="card">
      <h3>Order details</h3>
      <p class="card-sub">Choose the company this purchase is for, and the supplier.</p>
      <div class="form-row">
        <label>Company *
          <select id="po-company"><option value="">Select…</option>${companyOpts(po && po.company_id)}</select>
        </label>
        <label>Supplier *
          <select id="po-supplier"><option value="">Select…</option>${supplierOpts(po && po.supplier_id)}</select>
        </label>
        <label>Expected delivery date
          <input type="date" id="po-expected" value="${po && po.expected_date ? esc(po.expected_date.slice(0,10)) : ''}" />
        </label>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div><h3>Line items</h3><p class="card-sub" style="margin:0">Load rates from the supplier's rate list, or type items manually.</p></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" id="load-rates">↺ Load supplier rates</button>
          <button class="btn btn-outline btn-sm" id="add-line">+ Add line</button>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:14px">
        <table class="line-table">
          <thead><tr><th style="min-width:220px">Description</th><th class="col-qty">Qty</th><th class="col-rate">Rate</th><th class="col-amount">Amount</th><th></th></tr></thead>
          <tbody id="lines"></tbody>
        </table>
      </div>
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span><span id="t-subtotal" class="num">PKR 0.00</span></div>
        <div class="totals-row"><span>Tax %</span><span><input type="number" id="po-tax" value="${po ? po.tax_percent : 0}" step="0.01" min="0" style="width:90px;text-align:right"/></span></div>
        <div class="totals-row"><span>Tax amount</span><span id="t-tax" class="num">PKR 0.00</span></div>
        <div class="totals-row grand"><span>Total</span><span id="t-total" class="num">PKR 0.00</span></div>
      </div>
    </div>

    <div class="card">
      <label>Notes
        <textarea id="po-notes" rows="2" placeholder="Any special instructions for this purchase…">${po ? esc(po.notes || '') : ''}</textarea>
      </label>
    </div>

    <div class="form-actions">
      <a class="btn btn-outline" href="#/purchase-orders">Cancel</a>
      <button class="btn btn-outline" id="save-draft">Save draft</button>
      <button class="btn btn-primary" id="save-submit">${poId ? 'Save &amp; submit for approval' : 'Submit for approval'}</button>
    </div>
  `);

  const linesBody = $('#lines');
  function addLine(line = {}) {
    const tr = h(`<tr>
      <td><input class="li-desc" value="${esc(line.description || '')}" placeholder="Item / description" list="item-suggest" /></td>
      <td class="col-qty"><input type="number" class="li-qty" value="${line.quantity != null ? line.quantity : 1}" min="0" step="any" /></td>
      <td class="col-rate"><input type="number" class="li-rate" value="${line.rate != null ? line.rate : 0}" min="0" step="any" /></td>
      <td class="col-amount li-amount">PKR 0.00</td>
      <td><button class="btn btn-ghost btn-sm li-del" title="Remove" style="color:var(--danger)">✕</button></td>
    </tr>`);
    tr.querySelector('.li-del').onclick = () => { tr.remove(); recalc(); };
    tr.querySelectorAll('.li-qty, .li-rate').forEach((i) => i.oninput = recalc);
    linesBody.appendChild(tr);
    recalc();
  }
  function recalc() {
    let subtotal = 0;
    linesBody.querySelectorAll('tr').forEach((tr) => {
      const q = parseFloat(tr.querySelector('.li-qty').value) || 0;
      const r = parseFloat(tr.querySelector('.li-rate').value) || 0;
      const amt = q * r;
      subtotal += amt;
      tr.querySelector('.li-amount').textContent = money(amt);
    });
    const taxPct = parseFloat($('#po-tax').value) || 0;
    const tax = subtotal * (taxPct / 100);
    $('#t-subtotal').textContent = money(subtotal);
    $('#t-tax').textContent = money(tax);
    $('#t-total').textContent = money(subtotal + tax);
  }
  $('#po-tax').oninput = recalc;
  $('#add-line').onclick = () => addLine();

  // Datalist of items for description autocomplete.
  const dl = h('<datalist id="item-suggest"></datalist>');
  document.body.appendChild(dl);
  api('/items').then(({ items }) => {
    dl.innerHTML = items.map((i) => `<option value="${esc(i.name)}">`).join('');
  }).catch(() => {});

  $('#load-rates').onclick = async () => {
    const sid = $('#po-supplier').value;
    if (!sid) return toast('Pick a supplier first', '', 'error');
    const { rates } = await api(`/rate-lists/supplier/${sid}/rates`);
    if (!rates.length) return toast('No rate list found', 'This supplier has no active rate list yet.', 'error');
    openModal(`
      <h3>Add items from rate list</h3>
      <p class="card-sub">Tick the items to add. You can edit quantities afterwards.</p>
      <div class="table-wrap" style="max-height:340px;overflow:auto">
        <table><thead><tr><th><input type="checkbox" id="chk-all"/></th><th>Item</th><th class="text-right">Rate</th></tr></thead>
        <tbody>${rates.map((r, i) => `<tr><td><input type="checkbox" class="chk-rate" data-i="${i}"/></td><td>${esc(r.item_name)}${r.sku ? ` <span class="text-muted">(${esc(r.sku)})</span>` : ''}</td><td class="text-right num">${money(r.rate)}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="form-actions">
        <button class="btn btn-outline" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-add">Add selected</button>
      </div>`, { wide: true });
    $('#chk-all').onchange = (e) => document.querySelectorAll('.chk-rate').forEach((c) => c.checked = e.target.checked);
    $('#m-cancel').onclick = closeModal;
    $('#m-add').onclick = () => {
      document.querySelectorAll('.chk-rate:checked').forEach((c) => {
        const r = rates[+c.dataset.i];
        addLine({ description: r.item_name, quantity: 1, rate: r.rate });
      });
      closeModal();
    };
  };

  // Seed lines
  if (po && po.items && po.items.length) po.items.forEach((it) => addLine(it));
  else addLine();

  function collect(submit) {
    const items = [];
    linesBody.querySelectorAll('tr').forEach((tr) => {
      const description = tr.querySelector('.li-desc').value.trim();
      if (!description) return;
      items.push({
        description,
        quantity: parseFloat(tr.querySelector('.li-qty').value) || 0,
        rate: parseFloat(tr.querySelector('.li-rate').value) || 0,
      });
    });
    return {
      company_id: $('#po-company').value || null,
      supplier_id: $('#po-supplier').value || null,
      expected_date: $('#po-expected').value || null,
      tax_percent: parseFloat($('#po-tax').value) || 0,
      notes: $('#po-notes').value.trim() || null,
      items,
      submit,
    };
  }

  async function save(submit) {
    const payload = collect(submit);
    if (!payload.company_id) return toast('Company required', 'Choose Paramount or AiA.', 'error');
    if (!payload.supplier_id) return toast('Supplier required', '', 'error');
    if (!payload.items.length) return toast('Add at least one line item', '', 'error');
    try {
      let result;
      if (poId) {
        await api(`/purchase-orders/${poId}`, { method: 'PUT', body: payload });
        if (submit) await api(`/purchase-orders/${poId}/submit`, { method: 'POST' });
        result = { purchaseOrder: { id: poId } };
      } else {
        result = await api('/purchase-orders', { method: 'POST', body: payload });
      }
      toast(submit ? 'Submitted for approval' : 'Draft saved');
      renderNav();
      location.hash = `#/purchase-orders/${result.purchaseOrder.id}`;
    } catch (err) { toast('Could not save', err.message, 'error'); }
  }
  $('#save-draft').onclick = () => save(false);
  $('#save-submit').onclick = () => save(true);
}

/* ---------- Purchase Order detail ---------- */
async function viewPoDetail(poId) {
  setPage('Purchase Order');
  loading();
  const { purchaseOrder: po } = await api(`/purchase-orders/${poId}`);

  const isApprover = can('approver');
  const isOwner = State.user.id === po.created_by;
  const actions = [];
  if (po.status === 'draft' && (isOwner || can('approver'))) {
    actions.push(`<a class="btn btn-outline" href="#/purchase-orders/${po.id}/edit">Edit</a>`);
    actions.push(`<button class="btn btn-primary" data-act="submit">Submit for approval</button>`);
  }
  if (po.status === 'pending' && isApprover) {
    actions.push(`<button class="btn btn-success" data-act="approve">✓ Approve</button>`);
    actions.push(`<button class="btn btn-danger" data-act="reject">✕ Reject</button>`);
  }
  if (['draft', 'pending'].includes(po.status)) {
    actions.push(`<button class="btn btn-outline" data-act="cancel">Cancel PO</button>`);
  }
  actions.push(`<button class="btn btn-outline" data-act="print">🖨 Print</button>`);
  setPage(`PO ${po.po_number}`, actions.join(''));

  const itemRows = po.items.map((it) => `
    <tr><td>${esc(it.description)}</td><td class="text-right num">${it.quantity}</td>
    <td class="text-right num">${money(it.rate, po.currency)}</td>
    <td class="text-right num">${money(it.amount, po.currency)}</td></tr>`).join('');

  const timeline = po.history.map((e) => `
    <li><div class="tl-action">${esc(e.action)}</div>
    <div class="tl-meta">${esc(e.user_name || 'System')} · ${fmtDateTime(e.created_at)}${e.note ? ` · ${esc(e.note)}` : ''}</div></li>`).join('');

  renderRaw(`
    <div class="detail-header">
      <div>
        <h3 style="margin:0;font-size:22px">${esc(po.po_number)} ${badge(po.status)}</h3>
        <p class="text-muted" style="margin:4px 0 0">${esc(po.company_name)} · ${esc(po.supplier_name)}</p>
      </div>
    </div>
    ${po.status === 'rejected' && po.decision_note ? `<div class="card" style="border-left:4px solid var(--danger)"><strong>Rejected:</strong> ${esc(po.decision_note)}</div>` : ''}
    <div class="card">
      <div class="detail-meta">
        <div class="meta-item"><div class="meta-label">Company</div><div class="meta-value"><span class="badge company">${esc(po.company_code)}</span> ${esc(po.company_name)}</div></div>
        <div class="meta-item"><div class="meta-label">Supplier</div><div class="meta-value">${esc(po.supplier_name)}</div></div>
        <div class="meta-item"><div class="meta-label">Created by</div><div class="meta-value">${esc(po.created_by_name || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Expected date</div><div class="meta-value">${fmtDate(po.expected_date)}</div></div>
        ${po.approved_by_name ? `<div class="meta-item"><div class="meta-label">${po.status === 'rejected' ? 'Decided by' : 'Approved by'}</div><div class="meta-value">${esc(po.approved_by_name)}</div></div>` : ''}
        ${po.approved_at ? `<div class="meta-item"><div class="meta-label">Decision date</div><div class="meta-value">${fmtDate(po.approved_at)}</div></div>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Description</th><th class="text-right">Qty</th><th class="text-right">Rate</th><th class="text-right">Amount</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
      </div>
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span><span class="num">${money(po.subtotal, po.currency)}</span></div>
        <div class="totals-row"><span>Tax (${po.tax_percent}%)</span><span class="num">${money(po.tax_amount, po.currency)}</span></div>
        <div class="totals-row grand"><span>Total</span><span class="num">${money(po.total, po.currency)}</span></div>
      </div>
      ${po.notes ? `<div style="margin-top:16px"><div class="meta-label text-muted">Notes</div><div>${esc(po.notes)}</div></div>` : ''}
    </div>
    <div class="card">
      <h3>History</h3>
      <ul class="timeline">${timeline}</ul>
    </div>
  `);

  $('#topbar-actions').querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => poAction(btn.dataset.act, po);
  });
}

async function poAction(act, po) {
  if (act === 'print') { window.print(); return; }
  const doCall = async (path, body) => {
    try {
      await api(path, { method: 'POST', body });
      toast('Done');
      renderNav();
      viewPoDetail(po.id);
    } catch (err) { toast('Action failed', err.message, 'error'); }
  };
  if (act === 'submit') return doCall(`/purchase-orders/${po.id}/submit`);
  if (act === 'approve') {
    openModal(`<h3>Approve ${esc(po.po_number)}?</h3>
      <p class="card-sub">This authorises the purchase of ${money(po.total, po.currency)} for ${esc(po.company_name)}.</p>
      <label>Note (optional)<textarea id="dec-note" rows="2"></textarea></label>
      <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button>
      <button class="btn btn-success" id="confirm">Approve</button></div>`);
    $('#confirm').onclick = () => { closeModal(); doCall(`/purchase-orders/${po.id}/approve`, { note: $('#dec-note') && $('#dec-note').value }); };
    return;
  }
  if (act === 'reject') {
    openModal(`<h3>Reject ${esc(po.po_number)}?</h3>
      <label>Reason<textarea id="dec-note" rows="2" placeholder="Why is this being rejected?"></textarea></label>
      <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button>
      <button class="btn btn-danger" id="confirm">Reject</button></div>`);
    $('#confirm').onclick = () => { closeModal(); doCall(`/purchase-orders/${po.id}/reject`, { note: $('#dec-note').value }); };
    return;
  }
  if (act === 'cancel') {
    if (!confirm('Cancel this purchase order?')) return;
    return doCall(`/purchase-orders/${po.id}/cancel`);
  }
}
window.closeModalGlobal = closeModal;

/* ---------- Rate Lists ---------- */
async function viewRateLists() {
  const actions = can('staff', 'approver')
    ? `<a class="btn btn-outline" href="#/rate-lists/upload">⬆ Upload rate list</a> <button class="btn btn-primary" id="new-rl">+ New rate list</button>` : '';
  setPage('Rate Lists', actions);
  loading();
  const { rateLists } = await api('/rate-lists');

  const rows = rateLists.length ? rateLists.map((rl) => `
    <tr class="clickable" data-href="#/rate-lists/${rl.id}">
      <td><strong>${esc(rl.title)}</strong></td>
      <td>${esc(rl.supplier_name)}</td>
      <td>${rl.company_name ? `<span class="badge company">${esc(rl.company_name)}</span>` : '<span class="text-muted">All</span>'}</td>
      <td class="num">${rl.item_count}</td>
      <td>${badge(rl.status)}</td>
      <td class="text-muted">${fmtDate(rl.effective_date || rl.created_at)}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty"><div class="empty-icon">📋</div>No rate lists yet. Upload one or create it manually.</td></tr>';

  renderRaw(`<div class="table-wrap"><table>
    <thead><tr><th>Title</th><th>Supplier</th><th>Company</th><th>Items</th><th>Status</th><th>Effective</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`);
  wireRowLinks();
  if ($('#new-rl')) $('#new-rl').onclick = () => rateListFormModal();
}

async function rateListFormModal() {
  const { suppliers } = await api('/suppliers');
  const companies = State.companies.length ? State.companies : (await api('/companies')).companies;
  State.companies = companies;
  const activeSuppliers = suppliers.filter((s) => s.active);
  if (!activeSuppliers.length) return toast('Add a supplier first', 'Create a supplier before making a rate list.', 'error');
  openModal(`
    <h3>New rate list</h3>
    <label>Title *<input id="rl-title" placeholder="e.g. Al-Karam Textiles — 2026 prices" /></label>
    <div class="form-row">
      <label>Supplier *<select id="rl-supplier">${activeSuppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>Company<select id="rl-company"><option value="">All companies</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
    </div>
    <div class="form-row">
      <label>Currency<input id="rl-currency" value="PKR" /></label>
      <label>Effective date<input type="date" id="rl-date" /></label>
    </div>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="rl-save">Create</button></div>`);
  $('#rl-save').onclick = async () => {
    const title = $('#rl-title').value.trim();
    if (!title) return toast('Title required', '', 'error');
    try {
      const { rateList } = await api('/rate-lists', { method: 'POST', body: {
        title, supplier_id: $('#rl-supplier').value, company_id: $('#rl-company').value || null,
        currency: $('#rl-currency').value.trim() || 'PKR', effective_date: $('#rl-date').value || null,
      }});
      closeModal();
      toast('Rate list created', 'Now add item rates.');
      location.hash = `#/rate-lists/${rateList.id}`;
    } catch (err) { toast('Could not create', err.message, 'error'); }
  };
}

async function viewRateListUpload() {
  setPage('Upload Rate List');
  loading();
  const [{ suppliers }, { companies }] = await Promise.all([api('/suppliers'), api('/companies')]);
  State.companies = companies;
  const activeSuppliers = suppliers.filter((s) => s.active);

  renderRaw(`
    <div class="card">
      <h3>Upload a rate list</h3>
      <p class="card-sub">Upload a CSV of the items and rates you agreed with a supplier. Columns: <code>item_name, sku, unit, category, rate</code>. Items are created automatically if they don't exist yet.</p>
      ${activeSuppliers.length ? '' : '<div class="import-summary" style="background:var(--danger-soft);border-color:#fecaca">Add a supplier first — a rate list must belong to a supplier.</div>'}
      <div class="form-row">
        <label>Supplier *<select id="up-supplier"><option value="">Select…</option>${activeSuppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        <label>Company<select id="up-company"><option value="">All companies</option>${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="form-row">
        <label>Title (optional)<input id="up-title" placeholder="Defaults to supplier name" /></label>
        <label>Effective date<input type="date" id="up-date" /></label>
      </div>
      <label style="margin-top:14px">CSV file *
        <input type="file" id="up-file" accept=".csv,text/csv" />
      </label>
      <p class="field-hint">Using Excel? Choose <em>File → Save As → CSV</em> first. <a href="/api/rate-lists/template.csv">Download a template</a>.</p>
      <div class="form-actions">
        <a class="btn btn-outline" href="#/rate-lists">Cancel</a>
        <button class="btn btn-primary" id="up-submit">Upload &amp; create</button>
      </div>
      <div id="up-result"></div>
    </div>`);

  $('#up-submit').onclick = async () => {
    const file = $('#up-file').files[0];
    const supplierId = $('#up-supplier').value;
    if (!supplierId) return toast('Supplier required', '', 'error');
    if (!file) return toast('Choose a CSV file', '', 'error');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('supplier_id', supplierId);
    if ($('#up-company').value) fd.append('company_id', $('#up-company').value);
    if ($('#up-title').value.trim()) fd.append('title', $('#up-title').value.trim());
    if ($('#up-date').value) fd.append('effective_date', $('#up-date').value);
    const btn = $('#up-submit');
    btn.disabled = true;
    try {
      const { rateList, summary } = await api('/rate-lists/upload', { method: 'POST', body: fd });
      $('#up-result').innerHTML = `<div class="import-summary">
        <strong>✓ Imported ${summary.created} item${summary.created === 1 ? '' : 's'}</strong>${summary.skipped ? ` · ${summary.skipped} skipped` : ''}
        ${summary.errors.length ? `<ul>${summary.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      </div>`;
      toast('Rate list uploaded', `${summary.created} items imported.`);
      setTimeout(() => { location.hash = `#/rate-lists/${rateList.id}`; }, 900);
    } catch (err) {
      toast('Upload failed', err.message, 'error');
      btn.disabled = false;
    }
  };
}

async function viewRateListDetail(id) {
  setPage('Rate List');
  loading();
  const { rateList: rl } = await api(`/rate-lists/${id}`);
  const editable = can('staff', 'approver');
  const actions = editable ? `<button class="btn btn-primary" id="add-rate">+ Add item rate</button>` : '';
  setPage(rl.title, actions);

  const rows = rl.items.length ? rl.items.map((it) => `
    <tr>
      <td>${esc(it.item_name)}${it.sku ? ` <span class="text-muted">(${esc(it.sku)})</span>` : ''}</td>
      <td>${esc(it.category || '—')}</td>
      <td>${esc(it.unit || '')}</td>
      <td class="text-right num">${money(it.rate, rl.currency)}</td>
      ${editable ? `<td class="text-right"><button class="btn btn-ghost btn-sm" data-del="${it.id}" style="color:var(--danger)">✕</button></td>` : ''}
    </tr>`).join('')
    : `<tr><td colspan="${editable ? 5 : 4}" class="empty">No item rates yet.</td></tr>`;

  renderRaw(`
    <div class="card">
      <div class="detail-meta">
        <div class="meta-item"><div class="meta-label">Supplier</div><div class="meta-value">${esc(rl.supplier_name)}</div></div>
        <div class="meta-item"><div class="meta-label">Company</div><div class="meta-value">${rl.company_name ? esc(rl.company_name) : 'All companies'}</div></div>
        <div class="meta-item"><div class="meta-label">Currency</div><div class="meta-value">${esc(rl.currency)}</div></div>
        <div class="meta-item"><div class="meta-label">Effective</div><div class="meta-value">${fmtDate(rl.effective_date)}</div></div>
        <div class="meta-item"><div class="meta-label">Items</div><div class="meta-value">${rl.items.length}</div></div>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Category</th><th>Unit</th><th class="text-right">Rate</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody id="rl-rows">${rows}</tbody>
    </table></div>`);

  if (editable) {
    if ($('#add-rate')) $('#add-rate').onclick = () => addRateModal(id);
    document.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Remove this item from the rate list?')) return;
        await api(`/rate-lists/${id}/items/${b.dataset.del}`, { method: 'DELETE' });
        viewRateListDetail(id);
      };
    });
  }
}

async function addRateModal(listId) {
  const { items } = await api('/items');
  openModal(`
    <h3>Add item rate</h3>
    <label>Existing item<select id="ar-item"><option value="">— New item below —</option>${items.map((i) => `<option value="${i.id}">${esc(i.name)}${i.sku ? ` (${esc(i.sku)})` : ''}</option>`).join('')}</select></label>
    <div class="form-row">
      <label>Or new item name<input id="ar-name" placeholder="Item name" /></label>
      <label>SKU<input id="ar-sku" /></label>
    </div>
    <div class="form-row">
      <label>Unit<input id="ar-unit" placeholder="pcs" /></label>
      <label>Rate *<input type="number" id="ar-rate" step="any" min="0" /></label>
    </div>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ar-save">Add</button></div>`);
  $('#ar-save').onclick = async () => {
    const body = {
      item_id: $('#ar-item').value || null,
      item_name: $('#ar-name').value.trim() || null,
      sku: $('#ar-sku').value.trim() || null,
      unit: $('#ar-unit').value.trim() || null,
      rate: parseFloat($('#ar-rate').value) || 0,
    };
    if (!body.item_id && !body.item_name) return toast('Pick or name an item', '', 'error');
    try {
      await api(`/rate-lists/${listId}/items`, { method: 'POST', body });
      closeModal();
      viewRateListDetail(listId);
    } catch (err) { toast('Could not add', err.message, 'error'); }
  };
}

/* ---------- Suppliers ---------- */
async function viewSuppliers() {
  const actions = can('staff', 'approver') ? `<button class="btn btn-primary" id="new-supplier">+ New supplier</button>` : '';
  setPage('Suppliers', actions);
  loading();
  const { suppliers } = await api('/suppliers');
  const rows = suppliers.length ? suppliers.map((s) => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td>${esc(s.contact_person || '—')}</td>
      <td>${esc(s.email || '—')}</td>
      <td>${esc(s.phone || '—')}</td>
      <td>${s.active ? '<span class="badge active">Active</span>' : '<span class="badge cancelled">Inactive</span>'}</td>
      ${can('staff', 'approver') ? `<td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${s.id}">Edit</button></td>` : ''}
    </tr>`).join('')
    : `<tr><td colspan="6" class="empty"><div class="empty-icon">🏭</div>No suppliers yet.</td></tr>`;
  renderRaw(`<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Contact</th><th>Email</th><th>Phone</th><th>Status</th>${can('staff','approver') ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`);
  if ($('#new-supplier')) $('#new-supplier').onclick = () => supplierModal();
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => supplierModal(suppliers.find((s) => s.id == b.dataset.edit));
  });
}

function supplierModal(s) {
  const isEdit = !!s;
  openModal(`
    <h3>${isEdit ? 'Edit' : 'New'} supplier</h3>
    <label>Name *<input id="s-name" value="${isEdit ? esc(s.name) : ''}" /></label>
    <div class="form-row">
      <label>Contact person<input id="s-contact" value="${isEdit ? esc(s.contact_person || '') : ''}" /></label>
      <label>Email<input id="s-email" value="${isEdit ? esc(s.email || '') : ''}" /></label>
    </div>
    <div class="form-row">
      <label>Phone<input id="s-phone" value="${isEdit ? esc(s.phone || '') : ''}" /></label>
      ${isEdit ? `<label>Status<select id="s-active"><option value="1" ${s.active ? 'selected' : ''}>Active</option><option value="0" ${!s.active ? 'selected' : ''}>Inactive</option></select></label>` : ''}
    </div>
    <label>Address<textarea id="s-address" rows="2">${isEdit ? esc(s.address || '') : ''}</textarea></label>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="s-save">Save</button></div>`);
  $('#s-save').onclick = async () => {
    const name = $('#s-name').value.trim();
    if (!name) return toast('Name required', '', 'error');
    const body = {
      name, contact_person: $('#s-contact').value.trim(), email: $('#s-email').value.trim(),
      phone: $('#s-phone').value.trim(), address: $('#s-address').value.trim(),
    };
    if (isEdit) body.active = $('#s-active').value === '1';
    try {
      await api(isEdit ? `/suppliers/${s.id}` : '/suppliers', { method: isEdit ? 'PUT' : 'POST', body });
      closeModal(); viewSuppliers(); toast('Supplier saved');
    } catch (err) { toast('Could not save', err.message, 'error'); }
  };
}

/* ---------- Items ---------- */
async function viewItems() {
  const actions = can('staff', 'approver') ? `<button class="btn btn-primary" id="new-item">+ New item</button>` : '';
  setPage('Items', actions);
  loading();
  const { items } = await api('/items');
  const rows = items.length ? items.map((i) => `
    <tr>
      <td><strong>${esc(i.name)}</strong></td>
      <td>${esc(i.sku || '—')}</td>
      <td>${esc(i.unit)}</td>
      <td>${esc(i.category || '—')}</td>
      ${can('staff', 'approver') ? `<td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${i.id}">Edit</button></td>` : ''}
    </tr>`).join('')
    : `<tr><td colspan="5" class="empty"><div class="empty-icon">📦</div>No items yet. They're also created automatically when you upload a rate list.</td></tr>`;
  renderRaw(`<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>SKU</th><th>Unit</th><th>Category</th>${can('staff','approver') ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`);
  if ($('#new-item')) $('#new-item').onclick = () => itemModal();
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => itemModal(items.find((i) => i.id == b.dataset.edit));
  });
}

function itemModal(it) {
  const isEdit = !!it;
  openModal(`
    <h3>${isEdit ? 'Edit' : 'New'} item</h3>
    <label>Name *<input id="i-name" value="${isEdit ? esc(it.name) : ''}" /></label>
    <div class="form-row">
      <label>SKU<input id="i-sku" value="${isEdit ? esc(it.sku || '') : ''}" /></label>
      <label>Unit<input id="i-unit" value="${isEdit ? esc(it.unit) : 'pcs'}" /></label>
      <label>Category<input id="i-category" value="${isEdit ? esc(it.category || '') : ''}" /></label>
    </div>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="i-save">Save</button></div>`);
  $('#i-save').onclick = async () => {
    const name = $('#i-name').value.trim();
    if (!name) return toast('Name required', '', 'error');
    const body = { name, sku: $('#i-sku').value.trim(), unit: $('#i-unit').value.trim() || 'pcs', category: $('#i-category').value.trim() };
    try {
      await api(isEdit ? `/items/${it.id}` : '/items', { method: isEdit ? 'PUT' : 'POST', body });
      closeModal(); viewItems(); toast('Item saved');
    } catch (err) { toast('Could not save', err.message, 'error'); }
  };
}

/* ---------- Users (admin) ---------- */
async function viewUsers() {
  if (!can('admin')) { location.hash = '#/dashboard'; return; }
  setPage('Users', `<button class="btn btn-primary" id="new-user">+ New user</button>`);
  loading();
  const { users } = await api('/users');
  const rows = users.map((u) => `
    <tr>
      <td><strong>${esc(u.name)}</strong></td>
      <td>${esc(u.email)}</td>
      <td><span class="badge role-${esc(u.role)}">${esc(u.role)}</span></td>
      <td>${u.active ? '<span class="badge active">Active</span>' : '<span class="badge cancelled">Inactive</span>'}</td>
      <td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${u.id}">Edit</button></td>
    </tr>`).join('');
  renderRaw(`
    <div class="card" style="background:var(--primary-soft);border-color:#c7d7fe">
      <strong>Roles:</strong> <span class="badge role-staff">staff</span> create purchase orders & rate lists ·
      <span class="badge role-approver">approver</span> also approve/reject POs ·
      <span class="badge role-admin">admin</span> manage everything incl. users.
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`);
  $('#new-user').onclick = () => userModal();
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => userModal(users.find((u) => u.id == b.dataset.edit));
  });
}

function userModal(u) {
  const isEdit = !!u;
  const roleOpt = (r) => `<option value="${r}" ${u && u.role === r ? 'selected' : ''}>${r}</option>`;
  openModal(`
    <h3>${isEdit ? 'Edit' : 'New'} user</h3>
    <label>Name *<input id="u-name" value="${isEdit ? esc(u.name) : ''}" /></label>
    <label>Email *<input id="u-email" type="email" value="${isEdit ? esc(u.email) : ''}" ${isEdit ? 'disabled' : ''} /></label>
    <div class="form-row">
      <label>Role<select id="u-role">${['staff', 'approver', 'admin'].map(roleOpt).join('')}</select></label>
      ${isEdit ? `<label>Status<select id="u-active"><option value="1" ${u.active ? 'selected' : ''}>Active</option><option value="0" ${!u.active ? 'selected' : ''}>Inactive</option></select></label>` : ''}
    </div>
    <label>${isEdit ? 'New password (leave blank to keep)' : 'Password *'}<input id="u-password" type="password" placeholder="At least 6 characters" /></label>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="u-save">Save</button></div>`);
  $('#u-save').onclick = async () => {
    const name = $('#u-name').value.trim();
    const email = $('#u-email').value.trim();
    const password = $('#u-password').value;
    const role = $('#u-role').value;
    if (!name) return toast('Name required', '', 'error');
    try {
      if (isEdit) {
        const body = { name, role };
        body.active = $('#u-active').value === '1';
        if (password) body.password = password;
        await api(`/users/${u.id}`, { method: 'PUT', body });
      } else {
        if (!email) return toast('Email required', '', 'error');
        if (password.length < 6) return toast('Password too short', 'At least 6 characters.', 'error');
        await api('/users', { method: 'POST', body: { name, email, password, role } });
      }
      closeModal(); viewUsers(); toast('User saved');
    } catch (err) { toast('Could not save', err.message, 'error'); }
  };
}

/* ---------- Shared helpers ---------- */
function wireRowLinks() {
  document.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.onclick = () => { location.hash = tr.dataset.href; };
  });
}
function closeSidebar() { $('.sidebar').classList.remove('open'); $('#scrim').classList.add('hidden'); }

/* ---------- Boot ---------- */
async function bootApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await renderNav();
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
  else await router();
}

async function init() {
  $('#login-form').addEventListener('submit', doLogin);
  $('#logout-btn').addEventListener('click', doLogout);
  $('#menu-toggle').addEventListener('click', () => {
    $('.sidebar').classList.toggle('open');
    $('#scrim').classList.toggle('hidden');
  });
  $('#scrim').addEventListener('click', closeSidebar);
  window.addEventListener('hashchange', router);

  try {
    const { user } = await api('/auth/me');
    if (user) { State.user = user; await bootApp(); return; }
  } catch (_) {}
  $('#login-screen').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', init);
