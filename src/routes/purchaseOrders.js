'use strict';

const express = require('express');
const { query, one, run, tx, S } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

/** Next PO number for a company, e.g. PARAMOUNT-2026-0007. Uses client `c`. */
async function nextPoNumber(c, company) {
  const year = new Date().getFullYear();
  const prefix = `${company.code}-${year}-`;
  const last = await c.one(
    `SELECT po_number FROM ${S}.purchase_orders WHERE po_number LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let seq = 1;
  if (last) {
    const n = parseInt(last.po_number.slice(prefix.length), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** Recompute subtotal / tax / total from the PO line items. Uses client `c`. */
async function recalcTotals(c, poId, taxPercent) {
  const lines = await c.query(`SELECT quantity, rate FROM ${S}.po_items WHERE po_id = $1`, [poId]);
  const subtotal = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.rate), 0);
  const pct = Number.isFinite(taxPercent) ? taxPercent : 0;
  const taxAmount = +(subtotal * (pct / 100)).toFixed(2);
  const total = +(subtotal + taxAmount).toFixed(2);
  await c.run(
    `UPDATE ${S}.purchase_orders SET subtotal = $1, tax_percent = $2, tax_amount = $3, total = $4 WHERE id = $5`,
    [+subtotal.toFixed(2), pct, taxAmount, total, poId]
  );
}

async function logHistory(c, poId, action, note, userId) {
  await c.run(
    `INSERT INTO ${S}.po_history (po_id, action, note, user_id) VALUES ($1,$2,$3,$4)`,
    [poId, action, note || null, userId || null]
  );
}

async function writeLineItems(c, poId, items) {
  await c.run(`DELETE FROM ${S}.po_items WHERE po_id = $1`, [poId]);
  for (const line of items || []) {
    const description = (line.description || line.item_name || '').trim();
    if (!description) continue;
    const quantity = parseFloat(line.quantity) || 0;
    const rate = parseFloat(line.rate) || 0;
    await c.run(
      `INSERT INTO ${S}.po_items (po_id, item_id, description, quantity, rate, amount)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [poId, line.item_id || null, description, quantity, rate, +(quantity * rate).toFixed(2)]
    );
  }
}

/** Load a PO with joins, items and history. */
async function loadPo(id) {
  const po = await one(
    `SELECT po.*, c.name AS company_name, c.code AS company_code,
            s.name AS supplier_name, s.email AS supplier_email,
            cu.name AS created_by_name, au.name AS approved_by_name
       FROM ${S}.purchase_orders po
       JOIN ${S}.companies c ON c.id = po.company_id
       JOIN ${S}.suppliers s ON s.id = po.supplier_id
  LEFT JOIN ${S}.users cu ON cu.id = po.created_by
  LEFT JOIN ${S}.users au ON au.id = po.approved_by
      WHERE po.id = $1`,
    [id]
  );
  if (!po) return null;
  po.items = await query(`SELECT * FROM ${S}.po_items WHERE po_id = $1 ORDER BY id`, [id]);
  po.history = await query(
    `SELECT h.*, u.name AS user_name
       FROM ${S}.po_history h
  LEFT JOIN ${S}.users u ON u.id = h.user_id
      WHERE h.po_id = $1 ORDER BY h.id`,
    [id]
  );
  return po;
}

// GET /api/purchase-orders?company_id=&status=
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.company_id) { params.push(req.query.company_id); clauses.push(`po.company_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); clauses.push(`po.status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const purchaseOrders = await query(
      `SELECT po.id, po.po_number, po.status, po.total, po.currency, po.created_at,
              po.expected_date, c.name AS company_name, c.code AS company_code,
              s.name AS supplier_name, cu.name AS created_by_name
         FROM ${S}.purchase_orders po
         JOIN ${S}.companies c ON c.id = po.company_id
         JOIN ${S}.suppliers s ON s.id = po.supplier_id
    LEFT JOIN ${S}.users cu ON cu.id = po.created_by
        ${where}
        ORDER BY po.created_at DESC`,
      params
    );
    res.json({ purchaseOrders });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchase-orders/summary — dashboard counters
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const byStatus = await query(
      `SELECT status, COUNT(*)::int AS n FROM ${S}.purchase_orders GROUP BY status`
    );
    const byCompany = await query(
      `SELECT c.name AS company, c.code,
              COUNT(po.id)::int AS total,
              COUNT(*) FILTER (WHERE po.status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE po.status = 'approved')::int AS approved,
              COALESCE(SUM(po.total) FILTER (WHERE po.status = 'approved'), 0) AS approved_value
         FROM ${S}.companies c
    LEFT JOIN ${S}.purchase_orders po ON po.company_id = c.id
        GROUP BY c.id, c.name, c.code
        ORDER BY c.name`
    );
    res.json({ byStatus, byCompany });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchase-orders/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const purchaseOrder = await loadPo(req.params.id);
    if (!purchaseOrder) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({ purchaseOrder });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchase-orders — create (draft or submit)
router.post('/', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const { company_id, supplier_id, rate_list_id, tax_percent, expected_date, notes, items, submit } =
      req.body || {};
    if (!company_id) return res.status(400).json({ error: 'Company is required' });
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
    const company = await one(`SELECT * FROM ${S}.companies WHERE id = $1`, [company_id]);
    if (!company) return res.status(400).json({ error: 'Selected company does not exist' });
    const supplier = await one(`SELECT id FROM ${S}.suppliers WHERE id = $1`, [supplier_id]);
    if (!supplier) return res.status(400).json({ error: 'Selected supplier does not exist' });
    const validItems = Array.isArray(items)
      ? items.filter((i) => (i.description || i.item_name || '').trim())
      : [];
    if (!validItems.length) return res.status(400).json({ error: 'Add at least one line item' });

    const poId = await tx(async (c) => {
      const poNumber = await nextPoNumber(c, company);
      const status = submit ? 'pending' : 'draft';
      const po = await c.one(
        `INSERT INTO ${S}.purchase_orders
           (po_number, company_id, supplier_id, rate_list_id, status, currency, expected_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'PKR',$6,$7,$8) RETURNING id`,
        [poNumber, company_id, supplier_id, rate_list_id || null, status, expected_date || null, notes || null, req.user.id]
      );
      await writeLineItems(c, po.id, items);
      await recalcTotals(c, po.id, parseFloat(tax_percent) || 0);
      await logHistory(c, po.id, 'created', `PO ${poNumber} created`, req.user.id);
      if (submit) await logHistory(c, po.id, 'submitted', 'Submitted for approval', req.user.id);
      return po.id;
    });
    res.status(201).json({ purchaseOrder: await loadPo(poId) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/purchase-orders/:id — edit a draft
router.put('/:id', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const po = await one(`SELECT * FROM ${S}.purchase_orders WHERE id = $1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'draft') return res.status(409).json({ error: 'Only draft purchase orders can be edited' });
    const { supplier_id, company_id, rate_list_id, tax_percent, expected_date, notes, items } = req.body || {};

    await tx(async (c) => {
      await c.run(
        `UPDATE ${S}.purchase_orders
            SET company_id = $1, supplier_id = $2, rate_list_id = $3, expected_date = $4, notes = $5
          WHERE id = $6`,
        [
          company_id || po.company_id,
          supplier_id || po.supplier_id,
          rate_list_id !== undefined ? rate_list_id : po.rate_list_id,
          expected_date !== undefined ? expected_date : po.expected_date,
          notes !== undefined ? notes : po.notes,
          po.id,
        ]
      );
      if (Array.isArray(items)) await writeLineItems(c, po.id, items);
      await recalcTotals(c, po.id, tax_percent !== undefined ? parseFloat(tax_percent) || 0 : Number(po.tax_percent));
      await logHistory(c, po.id, 'updated', 'Draft updated', req.user.id);
    });
    res.json({ purchaseOrder: await loadPo(po.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchase-orders/:id/submit
router.post('/:id/submit', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const po = await one(`SELECT * FROM ${S}.purchase_orders WHERE id = $1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'draft') return res.status(409).json({ error: 'Only draft purchase orders can be submitted' });
    const count = await one(`SELECT COUNT(*)::int AS n FROM ${S}.po_items WHERE po_id = $1`, [po.id]);
    if (count.n === 0) return res.status(400).json({ error: 'Add at least one line item first' });
    await tx(async (c) => {
      await c.run(`UPDATE ${S}.purchase_orders SET status = 'pending' WHERE id = $1`, [po.id]);
      await logHistory(c, po.id, 'submitted', 'Submitted for approval', req.user.id);
    });
    res.json({ purchaseOrder: await loadPo(po.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchase-orders/:id/approve
router.post('/:id/approve', requireRole('approver'), async (req, res, next) => {
  try {
    const po = await one(`SELECT * FROM ${S}.purchase_orders WHERE id = $1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'pending') return res.status(409).json({ error: 'Only pending purchase orders can be approved' });
    if (po.created_by === req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You cannot approve a purchase order you created' });
    }
    const note = (req.body && req.body.note) || null;
    await tx(async (c) => {
      await c.run(
        `UPDATE ${S}.purchase_orders
            SET status = 'approved', approved_by = $1, approved_at = now(), decision_note = $2
          WHERE id = $3`,
        [req.user.id, note, po.id]
      );
      await logHistory(c, po.id, 'approved', note || 'Approved', req.user.id);
    });
    res.json({ purchaseOrder: await loadPo(po.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchase-orders/:id/reject
router.post('/:id/reject', requireRole('approver'), async (req, res, next) => {
  try {
    const po = await one(`SELECT * FROM ${S}.purchase_orders WHERE id = $1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (po.status !== 'pending') return res.status(409).json({ error: 'Only pending purchase orders can be rejected' });
    const note = (req.body && req.body.note) || null;
    await tx(async (c) => {
      await c.run(
        `UPDATE ${S}.purchase_orders
            SET status = 'rejected', approved_by = $1, approved_at = now(), decision_note = $2
          WHERE id = $3`,
        [req.user.id, note, po.id]
      );
      await logHistory(c, po.id, 'rejected', note || 'Rejected', req.user.id);
    });
    res.json({ purchaseOrder: await loadPo(po.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchase-orders/:id/cancel
router.post('/:id/cancel', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const po = await one(`SELECT * FROM ${S}.purchase_orders WHERE id = $1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (['approved', 'cancelled'].includes(po.status)) {
      return res.status(409).json({ error: `A ${po.status} purchase order cannot be cancelled` });
    }
    await tx(async (c) => {
      await c.run(`UPDATE ${S}.purchase_orders SET status = 'cancelled' WHERE id = $1`, [po.id]);
      await logHistory(c, po.id, 'cancelled', (req.body && req.body.note) || 'Cancelled', req.user.id);
    });
    res.json({ purchaseOrder: await loadPo(po.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
