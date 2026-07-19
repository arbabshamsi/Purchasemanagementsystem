'use strict';

/* ============================================================
   Purchase Management System — Requisition workflow frontend
   ============================================================ */

const State = { user: null, vendors: [] };

/* ---------- API ---------- */
async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, opts);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- utils ---------- */
function $(s, r = document) { return r.querySelector(s); }
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) {
  return `₹ ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.includes && s.includes('T') ? s : String(s).replace(' ', 'T') + (String(s).length <= 10 ? '' : 'Z'));
  if (isNaN(d)) return esc(s);
  return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s.includes && s.includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return esc(s);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const STATUS_LABEL = {
  draft: 'Draft', submitted: 'To source', sourced: 'To approve',
  approved: 'Approved', rejected: 'Rejected', po_made: 'PO made', cancelled: 'Cancelled',
};
function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}
function impBadge(imp) { return `<span class="badge imp-${esc(imp)}">${esc(imp)}</span>`; }
function can(...roles) { return State.user && (State.user.role === 'admin' || roles.includes(State.user.role)); }

function toast(title, msg = '', type = 'success') {
  const t = h(`<div class="toast ${type}"><div class="toast-title">${esc(title)}</div>${msg ? `<div class="toast-msg">${esc(msg)}</div>` : ''}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3400);
}
function openModal(html, { wide = false } = {}) {
  const host = $('#modal-host'), modal = $('#modal');
  modal.className = 'modal' + (wide ? ' wide' : '');
  modal.innerHTML = html;
  host.classList.remove('hidden');
  $('.modal-backdrop', host).onclick = closeModal;
  const f = modal.querySelector('input,select,textarea,button');
  if (f) setTimeout(() => f.focus(), 30);
}
function closeModal() { $('#modal-host').classList.add('hidden'); $('#modal').innerHTML = ''; }
window.closeModalGlobal = closeModal;

/* ---------- auth ---------- */
async function doLogin(e) {
  e.preventDefault();
  const form = e.target, errEl = $('#login-error');
  errEl.textContent = '';
  const btn = form.querySelector('button'); btn.disabled = true;
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: { email: form.email.value.trim(), password: form.password.value } });
    State.user = user; await bootApp();
  } catch (err) { errEl.textContent = err.message; } finally { btn.disabled = false; }
}
async function doLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
  State.user = null;
  $('#app').classList.add('hidden'); $('#login-screen').classList.remove('hidden');
}

/* ---------- nav ---------- */
const NAV = [
  { hash: '#/dashboard', label: 'Dashboard', icon: '📊' },
  { hash: '#/requisitions', label: 'Requisitions', icon: '📝' },
  { hash: '#/items', label: 'Item Master', icon: '📦' },
  { hash: '#/price-list', label: 'Price List', icon: '💰' },
  { hash: '#/vendors', label: 'Vendors', icon: '🏭' },
  { hash: '#/users', label: 'Users', icon: '👥', role: 'admin' },
];
async function renderNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  for (const item of NAV) {
    if (item.role && !can(item.role)) continue;
    nav.appendChild(h(`<a href="${item.hash}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span></a>`));
  }
  $('#user-box').innerHTML = `<div class="user-name">${esc(State.user.name)}</div><div class="user-role">${esc(State.user.role)}</div>`;
  highlightNav();
}
function highlightNav() {
  const cur = location.hash.split('/').slice(0, 2).join('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === cur));
}

/* ---------- router ---------- */
const routes = [];
function route(p, fn) { routes.push({ p, fn }); }
route(/^#\/dashboard$/, viewDashboard);
route(/^#\/requisitions$/, () => viewRequisitions());
route(/^#\/requisitions\/new$/, () => viewReqForm(null));
route(/^#\/requisitions\/(\d+)\/edit$/, (m) => viewReqForm(m[1]));
route(/^#\/requisitions\/(\d+)\/source$/, (m) => viewSourcing(m[1]));
route(/^#\/requisitions\/(\d+)$/, (m) => viewReqDetail(m[1]));
route(/^#\/items$/, viewItems);
route(/^#\/price-list$/, viewPriceList);
route(/^#\/vendors$/, viewVendors);
route(/^#\/users$/, viewUsers);

function setPage(title, actions = '') { $('#page-title').textContent = title; $('#topbar-actions').innerHTML = actions; }
function loading() { $('#view').innerHTML = '<div class="spinner">Loading…</div>'; }
function renderRaw(html) { $('#view').innerHTML = html; }
async function router() {
  if (!State.user) return;
  const hash = location.hash || '#/dashboard';
  closeSidebar(); highlightNav();
  for (const r of routes) {
    const m = hash.match(r.p);
    if (m) { try { await r.fn(m); } catch (e) { renderRaw(`<div class="empty"><div class="empty-icon">⚠️</div><p>${esc(e.message)}</p></div>`); } return; }
  }
  location.hash = '#/dashboard';
}
function wireRowLinks() {
  document.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
}
function closeSidebar() { $('.sidebar').classList.remove('open'); $('#scrim').classList.add('hidden'); }

/* ============================================================ VIEWS ============================================================ */

/* ---------- Dashboard ---------- */
async function viewDashboard() {
  setPage('Dashboard');
  loading();
  const [{ byStatus }, mine, toSource, toApprove, toPo] = await Promise.all([
    api('/requisitions/summary'),
    api('/requisitions?scope=mine'),
    can('purchaser') ? api('/requisitions?scope=to_source') : Promise.resolve({ requisitions: [] }),
    can('approver') ? api('/requisitions?scope=to_approve') : Promise.resolve({ requisitions: [] }),
    can('store') ? api('/requisitions?scope=to_po') : Promise.resolve({ requisitions: [] }),
  ]);
  const sm = Object.fromEntries(byStatus.map((s) => [s.status, s.n]));

  const cards = [];
  if (can('purchaser')) cards.push(queueCard('To source', toSource.requisitions.length, 'accent-primary', '#/requisitions?scope=to_source', 'requisitions waiting for vendor rates'));
  if (can('approver')) cards.push(queueCard('Awaiting your approval', toApprove.requisitions.length, 'accent-warning', '#/requisitions?scope=to_approve', 'vendor proposals to approve'));
  if (can('store')) cards.push(queueCard('Ready for PO', toPo.requisitions.length, 'accent-success', '#/requisitions?scope=to_po', 'approved — make PO in Tally'));
  cards.push(queueCard('My requisitions', mine.requisitions.length, 'accent-info', '#/requisitions?scope=mine', 'raised by you'));

  const recent = mine.requisitions.slice(0, 8);
  const focusList = (can('approver') ? toApprove.requisitions : can('purchaser') ? toSource.requisitions : mine.requisitions).slice(0, 8);
  const focusTitle = can('approver') ? 'Awaiting your approval' : can('purchaser') ? 'To source' : 'My recent requisitions';

  renderRaw(`
    <div class="grid grid-4">${cards.join('')}</div>
    <div class="card" style="margin-top:20px">
      <h3>${esc(focusTitle)}</h3>
      <p class="card-sub">Your action queue</p>
      ${reqTable(focusList.length ? focusList : recent)}
    </div>
    <div class="grid grid-4" style="margin-top:4px">
      ${['draft','submitted','sourced','approved','rejected','po_made'].map((s) => `
        <div class="stat"><div class="stat-label">${esc(STATUS_LABEL[s])}</div><div class="stat-value">${sm[s] || 0}</div></div>`).join('')}
    </div>`);
  wireRowLinks();
}
function queueCard(label, n, cls, href, hint) {
  return `<a class="stat ${cls}" href="${href}" style="text-decoration:none;color:inherit;display:block">
    <div class="stat-label">${esc(label)}</div><div class="stat-value">${n}</div><div class="stat-hint">${esc(hint)}</div></a>`;
}
function reqTable(list) {
  const rows = list.length ? list.map((r) => `
    <tr class="clickable" data-href="#/requisitions/${r.id}">
      <td><strong>${esc(r.req_number)}</strong></td>
      <td>${esc(r.department || '—')}</td>
      <td>${esc(r.requested_by_name || '—')}</td>
      <td>${impBadge(r.request_importance)}</td>
      <td class="num">${r.item_count}</td>
      <td>${badge(r.status)}</td>
      <td>${r.proposed_vendor_name ? esc(r.proposed_vendor_name) : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted">${fmtDate(r.created_at)}</td>
    </tr>`).join('')
    : '<tr><td colspan="8" class="empty">Nothing here right now</td></tr>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Req #</th><th>Dept</th><th>Requested by</th><th>Importance</th><th>Items</th><th>Status</th><th>Proposed vendor</th><th>Date</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/* ---------- Requisitions list ---------- */
async function viewRequisitions() {
  setPage('Requisitions', `<a class="btn btn-primary" href="#/requisitions/new">+ New Requisition</a>`);
  loading();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const scope = params.get('scope') || '';
  const tabs = [
    ['', 'All'], ['mine', 'Mine'],
    ...(can('purchaser') ? [['to_source', 'To source']] : []),
    ...(can('approver') ? [['to_approve', 'To approve']] : []),
    ...(can('store') ? [['to_po', 'Ready for PO']] : []),
  ];
  const q = scope ? `?scope=${scope}` : '';
  const { requisitions } = await api(`/requisitions${q}`);
  renderRaw(`
    <div class="tabs">${tabs.map(([v, l]) => `<a class="tab ${v === scope ? 'active' : ''}" href="#/requisitions${v ? `?scope=${v}` : ''}">${l}</a>`).join('')}</div>
    ${reqTable(requisitions)}`);
  wireRowLinks();
}

/* ---------- New / edit requisition (the slip) ---------- */
async function viewReqForm(id) {
  setPage(id ? 'Edit Requisition' : 'New Requisition');
  loading();
  let r = null;
  if (id) { r = (await api(`/requisitions/${id}`)).requisition; if (r.status !== 'draft') { location.hash = `#/requisitions/${id}`; return; } }
  const imp = r ? r.request_importance : 'normal';
  renderRaw(`
    <div class="card">
      <h3>Requisition details</h3>
      <p class="card-sub">Fill this like the purchase requisition slip.</p>
      <div class="form-row">
        <label>Department
          <input id="f-dept" value="${r ? esc(r.department || '') : esc(State.user.department || '')}" placeholder="e.g. Electric" /></label>
        <label>Party Name
          <input id="f-party" value="${r ? esc(r.party_name || '') : ''}" placeholder="Supplier/party if known" /></label>
        <label>Request Importance
          <select id="f-imp">${['low','normal','high','urgent'].map((x) => `<option value="${x}" ${x === imp ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      </div>
      <div class="form-row">
        <label>Payment Mode<input id="f-pay" value="${r ? esc(r.payment_mode || '') : ''}" placeholder="Cash / Credit / etc." /></label>
        <label>Required time for purchase<input id="f-reqtime" value="${r ? esc(r.required_time || '') : ''}" placeholder="e.g. 3 days" /></label>
        <label>Expected in-house date<input type="date" id="f-inhouse" value="${r && r.expected_inhouse_date ? esc(String(r.expected_inhouse_date).slice(0,10)) : ''}" /></label>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><h3>Items</h3><p class="card-sub" style="margin:0">What do you need?</p></div>
        <button class="btn btn-outline btn-sm" id="add-line">+ Add item</button>
      </div>
      <div class="table-wrap" style="margin-top:12px">
        <table class="line-table">
          <thead><tr><th style="min-width:200px">Product Description</th><th>Qty</th><th>Unit</th><th>Size</th><th style="min-width:150px">Purpose</th><th>Rate (if fixed)</th><th></th></tr></thead>
          <tbody id="lines"></tbody>
        </table>
      </div>
    </div>
    <datalist id="item-list"></datalist>
    <div class="card"><label>Notes<textarea id="f-notes" rows="2" placeholder="Anything else…">${r ? esc(r.notes || '') : ''}</textarea></label></div>
    <div class="form-actions">
      <a class="btn btn-outline" href="#/requisitions">Cancel</a>
      <button class="btn btn-outline" id="save-draft">Save draft</button>
      <button class="btn btn-primary" id="save-submit">Submit</button>
    </div>`);

  // Item-master autocomplete: suggest names and auto-fill the unit.
  const master = {};
  api('/items').then(({ items }) => {
    const dl = $('#item-list');
    if (dl) dl.innerHTML = items.map((i) => `<option value="${esc(i.name)}">`).join('');
    items.forEach((i) => { master[i.name.toLowerCase()] = i.unit; });
  }).catch(() => {});

  const lines = $('#lines');
  function addLine(it = {}) {
    const tr = h(`<tr>
      <td><input class="li-desc" value="${esc(it.product_description || '')}" placeholder="Item / description" list="item-list" /></td>
      <td class="col-qty"><input type="number" class="li-qty" value="${it.quantity != null ? it.quantity : 1}" min="0" step="any" /></td>
      <td class="col-qty"><input class="li-unit" value="${esc(it.unit || '')}" placeholder="Pc/Kg" /></td>
      <td class="col-qty"><input class="li-size" value="${esc(it.size || '')}" placeholder="Size" /></td>
      <td><input class="li-purpose" value="${esc(it.purpose || '')}" placeholder="Where it'll be used" /></td>
      <td class="col-rate"><input type="number" class="li-rate" value="${it.fixed_rate != null ? it.fixed_rate : ''}" min="0" step="any" placeholder="—" /></td>
      <td><button class="btn btn-ghost btn-sm li-del" style="color:var(--danger)">✕</button></td>
    </tr>`);
    tr.querySelector('.li-del').onclick = () => tr.remove();
    const desc = tr.querySelector('.li-desc');
    desc.oninput = () => {
      const u = master[desc.value.trim().toLowerCase()];
      const unitEl = tr.querySelector('.li-unit');
      if (u && !unitEl.value) unitEl.value = u;
    };
    lines.appendChild(tr);
  }
  $('#add-line').onclick = () => addLine();
  if (r && r.items && r.items.length) r.items.forEach(addLine); else { addLine(); addLine(); }

  function collect(submit) {
    const items = [];
    lines.querySelectorAll('tr').forEach((tr) => {
      const desc = tr.querySelector('.li-desc').value.trim();
      if (!desc) return;
      items.push({
        product_description: desc,
        quantity: parseFloat(tr.querySelector('.li-qty').value) || 0,
        unit: tr.querySelector('.li-unit').value.trim(),
        size: tr.querySelector('.li-size').value.trim(),
        purpose: tr.querySelector('.li-purpose').value.trim(),
        fixed_rate: tr.querySelector('.li-rate').value,
      });
    });
    return {
      department: $('#f-dept').value.trim(), party_name: $('#f-party').value.trim(),
      request_importance: $('#f-imp').value, payment_mode: $('#f-pay').value.trim(),
      required_time: $('#f-reqtime').value.trim(), expected_inhouse_date: $('#f-inhouse').value || null,
      notes: $('#f-notes').value.trim(), items, submit,
    };
  }
  async function save(submit) {
    const payload = collect(submit);
    if (!payload.items.length) return toast('Add at least one item', '', 'error');
    try {
      let result;
      if (id) {
        await api(`/requisitions/${id}`, { method: 'PUT', body: payload });
        if (submit) await api(`/requisitions/${id}/submit`, { method: 'POST' });
        result = { requisition: { id } };
      } else {
        result = await api('/requisitions', { method: 'POST', body: payload });
      }
      toast(submit ? 'Requisition submitted' : 'Draft saved');
      location.hash = `#/requisitions/${result.requisition.id}`;
    } catch (err) { toast('Could not save', err.message, 'error'); }
  }
  $('#save-draft').onclick = () => save(false);
  $('#save-submit').onclick = () => save(true);
}

/* ---------- Requisition detail ---------- */
async function viewReqDetail(id) {
  setPage('Requisition');
  loading();
  const { requisition: r } = await api(`/requisitions/${id}`);
  const isOwnerOfReq = State.user.id === r.created_by;
  const actions = [];
  if (r.status === 'draft' && (isOwnerOfReq || can('admin'))) {
    actions.push(`<a class="btn btn-outline" href="#/requisitions/${r.id}/edit">Edit</a>`);
    actions.push(`<button class="btn btn-primary" data-act="submit">Submit</button>`);
  }
  if (r.status === 'submitted' && can('purchaser')) actions.push(`<a class="btn btn-primary" href="#/requisitions/${r.id}/source">Source / compare vendors</a>`);
  if (r.status === 'sourced' && can('purchaser')) actions.push(`<a class="btn btn-outline" href="#/requisitions/${r.id}/source">Re-source</a>`);
  if (r.status === 'sourced' && can('approver')) {
    actions.push(`<button class="btn btn-success" data-act="approve">✓ Approve</button>`);
    actions.push(`<button class="btn btn-danger" data-act="reject">✕ Reject</button>`);
  }
  if (r.status === 'approved' && can('store')) actions.push(`<button class="btn btn-success" data-act="po">Mark PO made</button>`);
  if (['draft','submitted','sourced'].includes(r.status) && (isOwnerOfReq || can('admin'))) actions.push(`<button class="btn btn-outline" data-act="cancel">Cancel</button>`);
  actions.push(`<button class="btn btn-outline" data-act="print">🖨 Print</button>`);
  setPage(`Requisition ${r.req_number}`, actions.join(''));

  const itemRows = r.items.map((it, i) => `
    <tr><td>${i + 1}</td><td>${esc(it.product_description)}</td><td class="num">${it.quantity}</td>
    <td>${esc(it.unit || '—')}</td><td>${esc(it.size || '—')}</td><td>${esc(it.purpose || '—')}</td>
    <td class="text-right num">${it.fixed_rate != null ? money(it.fixed_rate) : '—'}</td></tr>`).join('');

  renderRaw(`
    <div class="detail-header">
      <div><h3 style="margin:0;font-size:22px">${esc(r.req_number)} ${badge(r.status)}</h3>
        <p class="text-muted" style="margin:4px 0 0">${esc(r.company_name || '')} · ${esc(r.department || '—')} · ${impBadge(r.request_importance)}</p></div>
    </div>
    ${r.status === 'rejected' && r.decision_note ? `<div class="card" style="border-left:4px solid var(--danger)"><strong>Rejected:</strong> ${esc(r.decision_note)}</div>` : ''}
    ${r.status === 'po_made' ? `<div class="card" style="border-left:4px solid var(--success)"><strong>PO made</strong>${r.po_reference ? ` — Ref: ${esc(r.po_reference)}` : ' (in Tally)'}</div>` : ''}
    <div class="card">
      <div class="detail-meta">
        <div class="meta-item"><div class="meta-label">Requested by</div><div class="meta-value">${esc(r.requested_by_name || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Party name</div><div class="meta-value">${esc(r.party_name || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Payment mode</div><div class="meta-value">${esc(r.payment_mode || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Required time</div><div class="meta-value">${esc(r.required_time || '—')}</div></div>
        <div class="meta-item"><div class="meta-label">Expected in-house</div><div class="meta-value">${fmtDate(r.expected_inhouse_date)}</div></div>
        ${r.proposed_vendor_name ? `<div class="meta-item"><div class="meta-label">Proposed vendor</div><div class="meta-value"><strong>${esc(r.proposed_vendor_name)}</strong></div></div>` : ''}
        ${r.purchaser_name ? `<div class="meta-item"><div class="meta-label">Sourced by</div><div class="meta-value">${esc(r.purchaser_name)}</div></div>` : ''}
        ${r.approved_by_name ? `<div class="meta-item"><div class="meta-label">${r.status === 'rejected' ? 'Decided by' : 'Approved by'}</div><div class="meta-value">${esc(r.approved_by_name)}</div></div>` : ''}
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>#</th><th>Product Description</th><th class="text-right">Qty</th><th>Unit</th><th>Size</th><th>Purpose</th><th class="text-right">Rate (if fixed)</th></tr></thead>
        <tbody>${itemRows}</tbody></table>
      </div>
      ${r.notes ? `<div style="margin-top:14px"><div class="meta-label text-muted">Notes</div><div>${esc(r.notes)}</div></div>` : ''}
    </div>
    ${r.quotes && r.quotes.length ? comparisonCard(r) : ''}
    <div class="card"><h3>History</h3><ul class="timeline">${r.history.map((e) => `
      <li><div class="tl-action">${esc(STATUS_LABEL[e.action] || e.action)}</div>
      <div class="tl-meta">${esc(e.user_name || 'System')} · ${fmtDateTime(e.created_at)}${e.note ? ` · ${esc(e.note)}` : ''}</div></li>`).join('')}</ul></div>`);

  $('#topbar-actions').querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => reqAction(b.dataset.act, r)));
}

function comparisonCard(r) {
  const vendors = r.quotes;
  const head = vendors.map((q) => `<th class="text-right ${q.is_awarded ? 'awarded' : ''}">${esc(q.vendor_name)}${q.is_awarded ? ' ★' : ''}</th>`).join('');
  const rows = r.items.map((it) => `
    <tr><td>${esc(it.product_description)} <span class="text-muted">(${it.quantity} ${esc(it.unit || '')})</span></td>
    ${vendors.map((q) => { const c = q.item_rates[it.id]; return `<td class="text-right num ${q.is_awarded ? 'awarded' : ''}">${c ? money(c.rate) : '—'}</td>`; }).join('')}</tr>`).join('');
  const totals = vendors.map((q) => `<td class="text-right num ${q.is_awarded ? 'awarded' : ''}"><strong>${money(q.total_amount)}</strong></td>`).join('');
  return `<div class="card">
    <h3>Vendor comparison</h3>
    <p class="card-sub">Rates gathered by ${esc(r.purchaser_name || 'purchaser')}. ★ = proposed/awarded.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th>${head}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td><strong>Total</strong></td>${totals}</tr></tfoot>
    </table></div>
    ${r.purchaser_note ? `<div style="margin-top:12px"><div class="meta-label text-muted">Purchaser note</div><div>${esc(r.purchaser_note)}</div></div>` : ''}
  </div>`;
}

async function reqAction(act, r) {
  if (act === 'print') return window.print();
  const call = async (path, body) => {
    try { await api(path, { method: 'POST', body }); toast('Done'); viewReqDetail(r.id); }
    catch (err) { toast('Action failed', err.message, 'error'); }
  };
  if (act === 'submit') return call(`/requisitions/${r.id}/submit`);
  if (act === 'approve') {
    openModal(`<h3>Approve ${esc(r.req_number)}?</h3><p class="card-sub">This gives the go-ahead for the store team to make the PO.</p>
      <label>Note (optional)<textarea id="note" rows="2"></textarea></label>
      <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-success" id="ok">Approve</button></div>`);
    return ($('#ok').onclick = () => { closeModal(); call(`/requisitions/${r.id}/approve`, { note: $('#note') && $('#note').value }); });
  }
  if (act === 'reject') {
    openModal(`<h3>Reject ${esc(r.req_number)}?</h3><label>Reason<textarea id="note" rows="2"></textarea></label>
      <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-danger" id="ok">Reject</button></div>`);
    return ($('#ok').onclick = () => { closeModal(); call(`/requisitions/${r.id}/reject`, { note: $('#note').value }); });
  }
  if (act === 'po') {
    openModal(`<h3>Mark PO made for ${esc(r.req_number)}?</h3><p class="card-sub">Confirm the PO has been created in Tally.</p>
      <label>Tally PO reference (optional)<input id="ref" placeholder="PO number" /></label>
      <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-success" id="ok">Mark PO made</button></div>`);
    return ($('#ok').onclick = () => { closeModal(); call(`/requisitions/${r.id}/po-made`, { po_reference: $('#ref').value.trim() }); });
  }
  if (act === 'cancel') { if (confirm('Cancel this requisition?')) call(`/requisitions/${r.id}/cancel`); }
}

/* ---------- Sourcing / vendor comparison (purchaser) ---------- */
async function viewSourcing(id) {
  setPage('Source requisition');
  loading();
  const [{ requisition: r }, { vendors }] = await Promise.all([api(`/requisitions/${id}`), api('/vendors')]);
  if (!['submitted', 'sourced'].includes(r.status)) { location.hash = `#/requisitions/${id}`; return; }
  State.vendors = vendors.filter((v) => v.active);
  setPage(`Source ${r.req_number}`);

  // selected vendor columns (pre-fill from existing quotes if re-sourcing)
  const selected = [];
  if (r.quotes && r.quotes.length) r.quotes.forEach((q) => selected.push({ vendor_id: q.vendor_id, rates: Object.fromEntries(Object.entries(q.item_rates).map(([k, v]) => [k, v.rate])) }));
  let awarded = (r.quotes.find((q) => q.is_awarded) || {}).vendor_id || null;

  renderRaw(`
    <div class="card">
      <h3>${esc(r.req_number)} — compare vendors</h3>
      <p class="card-sub">Add vendor columns, enter each vendor's rate per item, then pick the vendor to propose. Totals update live.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <select id="vendor-pick" style="max-width:280px"><option value="">+ Add vendor column…</option>${State.vendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select>
        <button class="btn btn-outline btn-sm" id="new-vendor">+ New vendor</button>
      </div>
      <div class="table-wrap"><table id="cmp"><thead></thead><tbody></tbody><tfoot></tfoot></table></div>
      <label style="margin-top:14px">Purchaser note (why this vendor)<textarea id="p-note" rows="2">${esc(r.purchaser_note || '')}</textarea></label>
      <div class="form-actions">
        <a class="btn btn-outline" href="#/requisitions/${r.id}">Cancel</a>
        <button class="btn btn-primary" id="send">Propose vendor for approval</button>
      </div>
    </div>`);

  const vname = (vid) => (State.vendors.find((v) => String(v.id) === String(vid)) || {}).name || 'Vendor';
  function draw() {
    const thead = $('#cmp thead'), tbody = $('#cmp tbody'), tfoot = $('#cmp tfoot');
    thead.innerHTML = `<tr><th style="min-width:200px">Item (qty)</th>${selected.map((s, i) => `
      <th class="text-right"><label style="display:flex;gap:6px;align-items:center;justify-content:flex-end;font-weight:600">
        <input type="radio" name="awarded" ${String(awarded) === String(s.vendor_id) ? 'checked' : ''} data-award="${s.vendor_id}"/> ${esc(vname(s.vendor_id))}</label>
        <button class="btn btn-ghost btn-sm rm-col" data-col="${i}" style="color:var(--danger)">remove</button></th>`).join('')}</tr>`;
    tbody.innerHTML = r.items.map((it) => `<tr><td>${esc(it.product_description)} <span class="text-muted">(${it.quantity} ${esc(it.unit || '')})</span></td>
      ${selected.map((s, i) => `<td class="col-rate"><input type="number" min="0" step="any" class="rate-in" data-col="${i}" data-item="${it.id}" value="${s.rates[it.id] != null ? s.rates[it.id] : ''}" placeholder="—"/></td>`).join('')}</tr>`).join('');
    tfoot.innerHTML = `<tr><td><strong>Total</strong></td>${selected.map((s, i) => `<td class="text-right num" data-total="${i}"><strong>—</strong></td>`).join('')}</tr>`;
    tbody.querySelectorAll('.rate-in').forEach((inp) => (inp.oninput = () => { selected[inp.dataset.col].rates[inp.dataset.item] = inp.value; recalc(); }));
    thead.querySelectorAll('[data-award]').forEach((rd) => (rd.onchange = () => (awarded = rd.dataset.award)));
    thead.querySelectorAll('.rm-col').forEach((b) => (b.onclick = () => { const c = +b.dataset.col; if (String(awarded) === String(selected[c].vendor_id)) awarded = null; selected.splice(c, 1); draw(); }));
    recalc();
  }
  function recalc() {
    selected.forEach((s, i) => {
      let t = 0;
      r.items.forEach((it) => { t += (parseFloat(s.rates[it.id]) || 0) * (Number(it.quantity) || 0); });
      const cell = $(`[data-total="${i}"]`); if (cell) cell.innerHTML = `<strong>${money(t)}</strong>`;
    });
  }
  $('#vendor-pick').onchange = (e) => {
    const vid = e.target.value; e.target.value = '';
    if (!vid || selected.some((s) => String(s.vendor_id) === String(vid))) return;
    selected.push({ vendor_id: vid, rates: {} }); draw();
  };
  $('#new-vendor').onclick = () => vendorModal(null, (v) => { State.vendors.push(v); $('#vendor-pick').appendChild(h(`<option value="${v.id}">${esc(v.name)}</option>`)); selected.push({ vendor_id: v.id, rates: {} }); draw(); });
  $('#send').onclick = async () => {
    if (!selected.length) return toast('Add at least one vendor', '', 'error');
    if (!awarded) return toast('Select the vendor to propose', 'Tick the radio on a vendor column.', 'error');
    const quotes = selected.map((s) => ({ vendor_id: s.vendor_id, item_rates: s.rates }));
    try {
      await api(`/requisitions/${r.id}/source`, { method: 'POST', body: { quotes, awarded_vendor_id: awarded, purchaser_note: $('#p-note').value.trim() } });
      toast('Sent for approval');
      location.hash = `#/requisitions/${r.id}`;
    } catch (err) { toast('Could not send', err.message, 'error'); }
  };
  draw();
}

/* ---------- Item Master ---------- */
async function viewItems() {
  const editable = can('purchaser', 'store');
  setPage('Item Master', editable ? `<button class="btn btn-outline" id="items-upload">⬆ Upload CSV</button> <button class="btn btn-primary" id="items-add">+ Add item</button>` : '');
  loading();
  const [{ items }, { categories }] = await Promise.all([api('/items'), api('/items/categories')]);
  renderRaw(`
    <p class="card-sub" style="margin:-8px 0 14px">The master list of everything you buy. Requisitions and the price list pick from here.</p>
    <div class="filters">
      <input id="im-search" placeholder="Search item…" />
      <select id="im-cat"><option value="">All categories</option>${categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join('')}</select>
    </div>
    <div id="im-table"></div>`);
  const draw = (list) => {
    const rows = list.length ? list.map((it) => `
      <tr>
        <td>${it.code ? `<code>${esc(it.code)}</code>` : '—'}</td>
        <td><strong>${esc(it.name)}</strong></td>
        <td>${it.category ? `<span class="badge company">${esc(it.category)}</span>` : '—'}</td>
        <td>${esc(it.unit)}</td>
        ${editable ? `<td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${it.id}">Edit</button> <button class="btn btn-ghost btn-sm" data-del="${it.id}" style="color:var(--danger)">✕</button></td>` : ''}
      </tr>`).join('')
      : `<tr><td colspan="${editable ? 5 : 4}" class="empty"><div class="empty-icon">📦</div>No items yet. Add one or upload a CSV.</td></tr>`;
    $('#im-table').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Unit</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
    if (editable) {
      document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => itemModal(list.find((x) => x.id == b.dataset.edit))));
      document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this item?')) { await api(`/items/${b.dataset.del}`, { method: 'DELETE' }); viewItems(); } }));
    }
  };
  draw(items);
  const apply = async () => {
    const p = new URLSearchParams();
    if ($('#im-search').value.trim()) p.set('search', $('#im-search').value.trim());
    if ($('#im-cat').value) p.set('category', $('#im-cat').value);
    draw((await api(`/items?${p}`)).items);
  };
  $('#im-search').oninput = apply; $('#im-cat').onchange = apply;
  if (editable) { $('#items-add').onclick = () => itemModal(null); $('#items-upload').onclick = () => itemUploadModal(); }
}
function itemModal(it) {
  const edit = !!it;
  openModal(`<h3>${edit ? 'Edit' : 'Add'} item</h3>
    <div class="form-row">
      <label>Code<input id="i-code" value="${edit ? esc(it.code || '') : ''}" placeholder="Optional"/></label>
      <label>Category<input id="i-cat" value="${edit ? esc(it.category || '') : ''}" list="cat-list" placeholder="Electrical / Transport…"/></label>
    </div>
    <label>Item name *<input id="i-name" value="${edit ? esc(it.name) : ''}"/></label>
    <div class="form-row">
      <label>Unit<input id="i-unit" value="${edit ? esc(it.unit) : 'pcs'}"/></label>
    </div>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ok">Save</button></div>`);
  $('#ok').onclick = async () => {
    const name = $('#i-name').value.trim(); if (!name) return toast('Item name required', '', 'error');
    const body = { code: $('#i-code').value.trim(), category: $('#i-cat').value.trim(), name, unit: $('#i-unit').value.trim() || 'pcs' };
    try { await api(edit ? `/items/${it.id}` : '/items', { method: edit ? 'PUT' : 'POST', body }); closeModal(); viewItems(); toast('Saved'); }
    catch (err) { toast('Could not save', err.message, 'error'); }
  };
}
function itemUploadModal() {
  openModal(`<h3>Upload Item Master (CSV)</h3>
    <p class="card-sub">Columns: <code>code, category, item_name, unit, notes</code>. Existing items (same name) are updated. <a href="/api/items/template.csv">Download template</a>.</p>
    <label>CSV file<input type="file" id="im-file" accept=".csv,text/csv"/></label>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ok">Upload</button></div>`);
  $('#ok').onclick = async () => {
    const f = $('#im-file').files[0]; if (!f) return toast('Choose a CSV file', '', 'error');
    const fd = new FormData(); fd.append('file', f); $('#ok').disabled = true;
    try {
      const { summary } = await api('/items/upload', { method: 'POST', body: fd });
      toast('Uploaded', `${summary.created} added, ${summary.updated} updated.`); closeModal(); viewItems();
    } catch (err) { toast('Upload failed', err.message, 'error'); $('#ok').disabled = false; }
  };
}

/* ---------- Price List ---------- */
async function viewPriceList() {
  const editable = can('purchaser', 'store');
  setPage('Price List', editable ? `<a class="btn btn-outline" href="#/price-list" id="upload-btn">⬆ Upload CSV</a> <button class="btn btn-primary" id="add-price">+ Add price</button>` : '');
  loading();
  const [{ prices }, { categories }] = await Promise.all([api('/price-list'), api('/price-list/categories')]);
  renderRaw(`
    <div class="filters">
      <input id="pl-search" placeholder="Search item…" />
      <select id="pl-cat"><option value="">All categories</option>${categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join('')}</select>
    </div>
    <div id="pl-table"></div>`);
  const draw = (list) => {
    const rows = list.length ? list.map((p) => `
      <tr>
        <td>${p.category ? `<span class="badge company">${esc(p.category)}</span>` : '—'}</td>
        <td><strong>${esc(p.item_name)}</strong></td>
        <td>${esc(p.unit)}</td>
        <td class="text-right num">${money(p.price)}</td>
        <td>${esc(p.vendor_name || '—')}</td>
        ${editable ? `<td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${p.id}">Edit</button> <button class="btn btn-ghost btn-sm" data-del="${p.id}" style="color:var(--danger)">✕</button></td>` : ''}
      </tr>`).join('')
      : `<tr><td colspan="${editable ? 6 : 5}" class="empty"><div class="empty-icon">💰</div>No prices yet. Add one or upload a CSV.</td></tr>`;
    $('#pl-table').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Category</th><th>Item</th><th>Unit</th><th class="text-right">Price</th><th>Vendor</th>${editable ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
    if (editable) {
      document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => priceModal(list.find((p) => p.id == b.dataset.edit))));
      document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this price?')) { await api(`/price-list/${b.dataset.del}`, { method: 'DELETE' }); viewPriceList(); } }));
    }
  };
  draw(prices);
  const apply = async () => {
    const p = new URLSearchParams();
    if ($('#pl-search').value.trim()) p.set('search', $('#pl-search').value.trim());
    if ($('#pl-cat').value) p.set('category', $('#pl-cat').value);
    draw((await api(`/price-list?${p}`)).prices);
  };
  $('#pl-search').oninput = apply; $('#pl-cat').onchange = apply;
  if (editable) { $('#add-price').onclick = () => priceModal(null); $('#upload-btn').onclick = (e) => { e.preventDefault(); priceUploadModal(); }; }
}
function priceModal(p) {
  const edit = !!p;
  openModal(`<h3>${edit ? 'Edit' : 'Add'} price</h3>
    <div class="form-row">
      <label>Category<input id="p-cat" value="${edit ? esc(p.category || '') : ''}" placeholder="Transport / Courier / Consumables…" list="cat-list"/></label>
      <label>Item name *<input id="p-name" value="${edit ? esc(p.item_name) : ''}" /></label>
    </div>
    <div class="form-row">
      <label>Unit<input id="p-unit" value="${edit ? esc(p.unit) : 'pcs'}" /></label>
      <label>Price *<input type="number" id="p-price" step="any" min="0" value="${edit ? p.price : ''}" /></label>
    </div>
    <label>Notes<input id="p-notes" value="${edit ? esc(p.notes || '') : ''}"/></label>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ok">Save</button></div>`);
  $('#ok').onclick = async () => {
    const name = $('#p-name').value.trim(); if (!name) return toast('Item name required', '', 'error');
    const body = { category: $('#p-cat').value.trim(), item_name: name, unit: $('#p-unit').value.trim() || 'pcs', price: $('#p-price').value, notes: $('#p-notes').value.trim() };
    try { await api(edit ? `/price-list/${p.id}` : '/price-list', { method: edit ? 'PUT' : 'POST', body }); closeModal(); viewPriceList(); toast('Saved'); }
    catch (err) { toast('Could not save', err.message, 'error'); }
  };
}
function priceUploadModal() {
  openModal(`<h3>Upload price list (CSV)</h3>
    <p class="card-sub">Columns: <code>category, item_name, unit, price, vendor, notes</code>. <a href="/api/price-list/template.csv">Download template</a>.</p>
    <label>CSV file<input type="file" id="pl-file" accept=".csv,text/csv" /></label>
    <div id="pl-res"></div>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ok">Upload</button></div>`);
  $('#ok').onclick = async () => {
    const f = $('#pl-file').files[0]; if (!f) return toast('Choose a CSV file', '', 'error');
    const fd = new FormData(); fd.append('file', f);
    $('#ok').disabled = true;
    try {
      const { summary } = await api('/price-list/upload', { method: 'POST', body: fd });
      toast('Uploaded', `${summary.created} prices imported.`); closeModal(); viewPriceList();
    } catch (err) { toast('Upload failed', err.message, 'error'); $('#ok').disabled = false; }
  };
}

/* ---------- Vendors ---------- */
async function viewVendors() {
  const editable = can('purchaser', 'store');
  setPage('Vendors', editable ? `<button class="btn btn-primary" id="new-vendor">+ New vendor</button>` : '');
  loading();
  const { vendors } = await api('/vendors');
  const rows = vendors.length ? vendors.map((v) => `
    <tr><td><strong>${esc(v.name)}</strong></td><td>${esc(v.contact_person || '—')}</td><td>${esc(v.phone || '—')}</td>
    <td>${esc(v.email || '—')}</td><td>${esc(v.gst_number || '—')}</td>
    <td>${v.active ? '<span class="badge active">Active</span>' : '<span class="badge cancelled">Inactive</span>'}</td>
    ${editable ? `<td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${v.id}">Edit</button></td>` : ''}</tr>`).join('')
    : `<tr><td colspan="7" class="empty"><div class="empty-icon">🏭</div>No vendors yet.</td></tr>`;
  renderRaw(`<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>GST</th><th>Status</th>${editable ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows}</tbody></table></div>`);
  if (editable) {
    $('#new-vendor').onclick = () => vendorModal(null, () => viewVendors());
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => vendorModal(vendors.find((v) => v.id == b.dataset.edit), () => viewVendors())));
  }
}
function vendorModal(v, onSaved) {
  const edit = !!v;
  openModal(`<h3>${edit ? 'Edit' : 'New'} vendor</h3>
    <label>Name *<input id="v-name" value="${edit ? esc(v.name) : ''}" /></label>
    <div class="form-row"><label>Contact person<input id="v-contact" value="${edit ? esc(v.contact_person || '') : ''}"/></label>
      <label>Phone<input id="v-phone" value="${edit ? esc(v.phone || '') : ''}"/></label></div>
    <div class="form-row"><label>Email<input id="v-email" value="${edit ? esc(v.email || '') : ''}"/></label>
      <label>GST number<input id="v-gst" value="${edit ? esc(v.gst_number || '') : ''}"/></label></div>
    <label>Address<textarea id="v-address" rows="2">${edit ? esc(v.address || '') : ''}</textarea></label>
    ${edit ? `<label>Status<select id="v-active"><option value="1" ${v.active ? 'selected' : ''}>Active</option><option value="0" ${!v.active ? 'selected' : ''}>Inactive</option></select></label>` : ''}
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ok">Save</button></div>`);
  $('#ok').onclick = async () => {
    const name = $('#v-name').value.trim(); if (!name) return toast('Name required', '', 'error');
    const body = { name, contact_person: $('#v-contact').value.trim(), phone: $('#v-phone').value.trim(), email: $('#v-email').value.trim(), gst_number: $('#v-gst').value.trim(), address: $('#v-address').value.trim() };
    if (edit) body.active = $('#v-active').value === '1';
    try {
      const res = await api(edit ? `/vendors/${v.id}` : '/vendors', { method: edit ? 'PUT' : 'POST', body });
      closeModal(); toast('Vendor saved'); if (onSaved) onSaved(res.vendor);
    } catch (err) { toast('Could not save', err.message, 'error'); }
  };
}

/* ---------- Users ---------- */
async function viewUsers() {
  if (!can('admin')) { location.hash = '#/dashboard'; return; }
  setPage('Users', `<button class="btn btn-primary" id="new-user">+ New user</button>`);
  loading();
  const { users } = await api('/users');
  const rows = users.map((u) => `
    <tr><td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td>
    <td><span class="badge role-${esc(u.role)}">${esc(u.role)}</span></td><td>${esc(u.department || '—')}</td>
    <td>${u.active ? '<span class="badge active">Active</span>' : '<span class="badge cancelled">Inactive</span>'}</td>
    <td class="text-right"><button class="btn btn-outline btn-sm" data-edit="${u.id}">Edit</button></td></tr>`).join('');
  renderRaw(`
    <div class="card" style="background:var(--primary-soft);border-color:#c7d7fe;font-size:13px">
      <strong>Roles:</strong>
      <span class="badge role-staff">staff</span> raise requisitions ·
      <span class="badge role-purchaser">purchaser</span> source & propose vendors ·
      <span class="badge role-approver">approver</span> final approval ·
      <span class="badge role-store">store</span> mark PO made ·
      <span class="badge role-admin">admin</span> everything + users.
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`);
  $('#new-user').onclick = () => userModal();
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => userModal(users.find((u) => u.id == b.dataset.edit))));
}
function userModal(u) {
  const edit = !!u;
  const roleOpt = (r) => `<option value="${r}" ${u && u.role === r ? 'selected' : ''}>${r}</option>`;
  openModal(`<h3>${edit ? 'Edit' : 'New'} user</h3>
    <label>Name *<input id="u-name" value="${edit ? esc(u.name) : ''}" /></label>
    <label>Email *<input id="u-email" type="email" value="${edit ? esc(u.email) : ''}" ${edit ? 'disabled' : ''}/></label>
    <div class="form-row">
      <label>Role<select id="u-role">${['staff','purchaser','approver','store','admin'].map(roleOpt).join('')}</select></label>
      <label>Department<input id="u-dept" value="${edit ? esc(u.department || '') : ''}"/></label>
      ${edit ? `<label>Status<select id="u-active"><option value="1" ${u.active ? 'selected' : ''}>Active</option><option value="0" ${!u.active ? 'selected' : ''}>Inactive</option></select></label>` : ''}
    </div>
    <label>${edit ? 'New password (blank = keep)' : 'Password *'}<input id="u-pass" type="password" placeholder="At least 6 characters"/></label>
    <div class="form-actions"><button class="btn btn-outline" onclick="closeModalGlobal()">Cancel</button><button class="btn btn-primary" id="ok">Save</button></div>`);
  $('#ok').onclick = async () => {
    const name = $('#u-name').value.trim(); if (!name) return toast('Name required', '', 'error');
    const pass = $('#u-pass').value, role = $('#u-role').value, dept = $('#u-dept').value.trim();
    try {
      if (edit) {
        const body = { name, role, department: dept };
        body.active = $('#u-active').value === '1';
        if (pass) body.password = pass;
        await api(`/users/${u.id}`, { method: 'PUT', body });
      } else {
        const email = $('#u-email').value.trim();
        if (!email) return toast('Email required', '', 'error');
        if (pass.length < 6) return toast('Password too short', 'At least 6 characters.', 'error');
        await api('/users', { method: 'POST', body: { name, email, password: pass, role, department: dept } });
      }
      closeModal(); viewUsers(); toast('User saved');
    } catch (err) { toast('Could not save', err.message, 'error'); }
  };
}

/* ---------- boot ---------- */
async function bootApp() {
  $('#login-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
  await renderNav();
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard'; else await router();
}
async function init() {
  $('#login-form').addEventListener('submit', doLogin);
  $('#logout-btn').addEventListener('click', doLogout);
  $('#menu-toggle').addEventListener('click', () => { $('.sidebar').classList.toggle('open'); $('#scrim').classList.toggle('hidden'); });
  $('#scrim').addEventListener('click', closeSidebar);
  window.addEventListener('hashchange', router);
  // shared datalist for price categories
  document.body.appendChild(h('<datalist id="cat-list"><option value="Transportation"><option value="Courier"><option value="Consumables"><option value="Non-Consumables"><option value="Freight Forwarding"><option value="Electrical"><option value="Stationery"><option value="Maintenance"></datalist>'));
  try { const { user } = await api('/auth/me'); if (user) { State.user = user; await bootApp(); return; } } catch (_) {}
  $('#login-screen').classList.remove('hidden');
}
document.addEventListener('DOMContentLoaded', init);
