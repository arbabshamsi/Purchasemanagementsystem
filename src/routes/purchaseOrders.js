'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

/** Generate the next PO number for a company, e.g. PARAMOUNT-2026-0007. */
function nextPoNumber(company) {
  const year = new Date().getFullYear();
  const prefix = `${company.code}-${year}-`;
  const last = db
    .prepare(
      `SELECT po_number FROM purchase_orders
        WHERE po_number LIKE ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(`${prefix}%`);
  let seq = 1;
  if (last) {
    const n = parseInt(last.po_number.slice(prefix.length), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** Recompute and persist subtotal / tax / total from the PO's line items. */
function recalcTotals(poId, taxPercent) {
  const lines = db.prepare('SELECT quantity, rate FROM po_items WHERE po_id = ?').all(poId);
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.rate, 0);
  const pct = Number.isFinite(taxPercent) ? taxPercent : 0;
  const taxAmount = +(subtotal * (pct / 100)).toFixed(2);
  const total = +(subtotal + taxAmount).toFixed(2);
  db.prepare(
    'UPDATE purchase_orders SET subtotal = ?, tax_percent = ?, tax_amount = ?, total = ? WHERE id = ?'
  ).run(+subtotal.toFixed(2), pct, taxAmount, total, poId);
}

function logHistory(poId, action, note, userId) {
  db.prepare(
    'INSERT INTO po_history (po_id, action, note, user_id) VALUES (?, ?, ?, ?)'
  ).run(poId, action, note || null, userId || null);
}

/** Load a PO with company, supplier, creator, approver, items and history. */
function loadPo(id) {
  const po = db
    .prepare(
      `SELECT po.*, c.name AS company_name, c.code AS company_code,
              s.name AS supplier_name, s.email AS supplier_email,
              cu.name AS created_by_name, au.name AS approved_by_name
         FROM purchase_orders po
         JOIN companies c ON c.id = po.company_id
         JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN users cu ON cu.id = po.created_by
    LEFT JOIN users au ON au.id = po.approved_by
        WHERE po.id = ?`
    )
    .get(id);
  if (!po) return null;
  po.items = db
    .prepare('SELECT * FROM po_items WHERE po_id = ? ORDER BY id')
    .all(id);
  po.history = db
    .prepare(
      `SELECT h.*, u.name AS user_name
         FROM po_history h
    LEFT JOIN users u ON u.id = h.user_id
        WHERE h.po_id = ?
        ORDER BY h.id`
    )
    .all(id);
  return po;
}

function writeLineItems(poId, items) {
  db.prepare('DELETE FROM po_items WHERE po_id = ?').run(poId);
  const insert = db.prepare(
    'INSERT INTO po_items (po_id, item_id, description, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const line of items || []) {
    const description = (line.description || line.item_name || '').trim();
    if (!description) continue;
    const quantity = parseFloat(line.quantity) || 0;
    const rate = parseFloat(line.rate) || 0;
    insert.run(poId, line.item_id || null, description, quantity, rate, +(quantity * rate).toFixed(2));
  }
}

// GET /api/purchase-orders?company_id=&status=
router.get('/', requireAuth, (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.company_id) {
    clauses.push('po.company_id = ?');
    params.push(req.query.company_id);
  }
  if (req.query.status) {
    clauses.push('po.status = ?');
    params.push(req.query.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT po.id, po.po_number, po.status, po.total, po.currency, po.created_at,
              po.expected_date, c.name AS company_name, c.code AS company_code,
              s.name AS supplier_name, cu.name AS created_by_name
         FROM purchase_orders po
         JOIN companies c ON c.id = po.company_id
         JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN users cu ON cu.id = po.created_by
        ${where}
        ORDER BY po.created_at DESC`
    )
    .all(...params);
  res.json({ purchaseOrders: rows });
});

// GET /api/purchase-orders/summary — dashboard counters
router.get('/summary', requireAuth, (req, res) => {
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM purchase_orders GROUP BY status')
    .all();
  const byCompany = db
    .prepare(
      `SELECT c.name AS company, c.code,
              COUNT(po.id) AS total,
              SUM(CASE WHEN po.status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN po.status = 'approved' THEN 1 ELSE 0 END) AS approved,
              COALESCE(SUM(CASE WHEN po.status = 'approved' THEN po.total ELSE 0 END), 0) AS approved_value
         FROM companies c
    LEFT JOIN purchase_orders po ON po.company_id = c.id
        GROUP BY c.id
        ORDER BY c.name`
    )
    .all();
  res.json({ byStatus, byCompany });
});

// GET /api/purchase-orders/:id
router.get('/:id', requireAuth, (req, res) => {
  const po = loadPo(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json({ purchaseOrder: po });
});

// POST /api/purchase-orders — create (status: draft or pending on submit)
router.post('/', requireRole('staff', 'approver'), (req, res) => {
  const { company_id, supplier_id, rate_list_id, tax_percent, expected_date, notes, items, submit } =
    req.body || {};
  if (!company_id) return res.status(400).json({ error: 'Company is required' });
  if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(company_id);
  if (!company) return res.status(400).json({ error: 'Selected company does not exist' });
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplier_id);
  if (!supplier) return res.status(400).json({ error: 'Selected supplier does not exist' });
  if (!Array.isArray(items) || items.filter((i) => (i.description || i.item_name || '').trim()).length === 0) {
    return res.status(400).json({ error: 'Add at least one line item' });
  }

  const tx = db.transaction(() => {
    const poNumber = nextPoNumber(company);
    const status = submit ? 'pending' : 'draft';
    const result = db
      .prepare(
        `INSERT INTO purchase_orders
           (po_number, company_id, supplier_id, rate_list_id, status, currency, expected_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        poNumber,
        company_id,
        supplier_id,
        rate_list_id || null,
        status,
        'PKR',
        expected_date || null,
        notes || null,
        req.user.id
      );
    const poId = result.lastInsertRowid;
    writeLineItems(poId, items);
    recalcTotals(poId, parseFloat(tax_percent) || 0);
    logHistory(poId, 'created', `PO ${poNumber} created`, req.user.id);
    if (submit) logHistory(poId, 'submitted', 'Submitted for approval', req.user.id);
    return poId;
  });

  const poId = tx();
  res.status(201).json({ purchaseOrder: loadPo(poId) });
});

// PUT /api/purchase-orders/:id — edit a draft
router.put('/:id', requireRole('staff', 'approver'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'draft') {
    return res.status(409).json({ error: 'Only draft purchase orders can be edited' });
  }

  const { supplier_id, company_id, rate_list_id, tax_percent, expected_date, notes, items } =
    req.body || {};
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE purchase_orders
          SET company_id = ?, supplier_id = ?, rate_list_id = ?, expected_date = ?, notes = ?
        WHERE id = ?`
    ).run(
      company_id || po.company_id,
      supplier_id || po.supplier_id,
      rate_list_id !== undefined ? rate_list_id : po.rate_list_id,
      expected_date !== undefined ? expected_date : po.expected_date,
      notes !== undefined ? notes : po.notes,
      po.id
    );
    if (Array.isArray(items)) writeLineItems(po.id, items);
    recalcTotals(po.id, tax_percent !== undefined ? parseFloat(tax_percent) || 0 : po.tax_percent);
    logHistory(po.id, 'updated', 'Draft updated', req.user.id);
  });
  tx();
  res.json({ purchaseOrder: loadPo(po.id) });
});

// POST /api/purchase-orders/:id/submit — draft -> pending
router.post('/:id/submit', requireRole('staff', 'approver'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'draft') {
    return res.status(409).json({ error: 'Only draft purchase orders can be submitted' });
  }
  const lineCount = db.prepare('SELECT COUNT(*) AS n FROM po_items WHERE po_id = ?').get(po.id).n;
  if (lineCount === 0) return res.status(400).json({ error: 'Add at least one line item first' });

  db.prepare("UPDATE purchase_orders SET status = 'pending' WHERE id = ?").run(po.id);
  logHistory(po.id, 'submitted', 'Submitted for approval', req.user.id);
  res.json({ purchaseOrder: loadPo(po.id) });
});

// POST /api/purchase-orders/:id/approve — pending -> approved (approver/admin)
router.post('/:id/approve', requireRole('approver'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending purchase orders can be approved' });
  }
  if (po.created_by === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You cannot approve a purchase order you created' });
  }

  db.prepare(
    `UPDATE purchase_orders
        SET status = 'approved', approved_by = ?, approved_at = datetime('now'), decision_note = ?
      WHERE id = ?`
  ).run(req.user.id, (req.body && req.body.note) || null, po.id);
  logHistory(po.id, 'approved', (req.body && req.body.note) || 'Approved', req.user.id);
  res.json({ purchaseOrder: loadPo(po.id) });
});

// POST /api/purchase-orders/:id/reject — pending -> rejected (approver/admin)
router.post('/:id/reject', requireRole('approver'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending purchase orders can be rejected' });
  }
  const note = (req.body && req.body.note) || null;
  db.prepare(
    `UPDATE purchase_orders
        SET status = 'rejected', approved_by = ?, approved_at = datetime('now'), decision_note = ?
      WHERE id = ?`
  ).run(req.user.id, note, po.id);
  logHistory(po.id, 'rejected', note || 'Rejected', req.user.id);
  res.json({ purchaseOrder: loadPo(po.id) });
});

// POST /api/purchase-orders/:id/cancel
router.post('/:id/cancel', requireRole('staff', 'approver'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (['approved', 'cancelled'].includes(po.status)) {
    return res.status(409).json({ error: `A ${po.status} purchase order cannot be cancelled` });
  }
  db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(po.id);
  logHistory(po.id, 'cancelled', (req.body && req.body.note) || 'Cancelled', req.user.id);
  res.json({ purchaseOrder: loadPo(po.id) });
});

module.exports = router;
