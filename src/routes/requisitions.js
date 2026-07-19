'use strict';

const express = require('express');
const { query, one, run, tx, S } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify } = require('../notify');

const router = express.Router();

/* ---------- helpers ---------- */

async function nextReqNumber(c) {
  const year = new Date().getFullYear();
  const prefix = `PHC-REQ-${year}-`;
  const last = await c.one(
    `SELECT req_number FROM ${S}.requisitions WHERE req_number LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let seq = 1;
  if (last) {
    const n = parseInt(last.req_number.slice(prefix.length), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

async function logHistory(c, reqId, action, note, userId) {
  await c.run(
    `INSERT INTO ${S}.requisition_history (requisition_id, action, note, user_id) VALUES ($1,$2,$3,$4)`,
    [reqId, action, note || null, userId || null]
  );
}

async function writeItems(c, reqId, items) {
  await c.run(`DELETE FROM ${S}.requisition_items WHERE requisition_id = $1`, [reqId]);
  let order = 0;
  for (const it of items || []) {
    const desc = (it.product_description || '').trim();
    if (!desc) continue;
    await c.run(
      `INSERT INTO ${S}.requisition_items
         (requisition_id, product_description, quantity, unit, size, purpose, fixed_rate, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        reqId,
        desc,
        parseFloat(it.quantity) || 0,
        (it.unit || '').trim() || null,
        (it.size || '').trim() || null,
        (it.purpose || '').trim() || null,
        it.fixed_rate !== undefined && it.fixed_rate !== '' ? parseFloat(it.fixed_rate) || 0 : null,
        order++,
      ]
    );
  }
}

/** Full requisition with items, quotes (+ quote items), history and names. */
async function loadRequisition(id) {
  const req = await one(
    `SELECT r.*, c.name AS company_name,
            ru.name AS requested_by_display, pu.name AS purchaser_name, au.name AS approved_by_name,
            pv.name AS proposed_vendor_name
       FROM ${S}.requisitions r
  LEFT JOIN ${S}.companies c ON c.id = r.company_id
  LEFT JOIN ${S}.users ru ON ru.id = r.requested_by
  LEFT JOIN ${S}.users pu ON pu.id = r.purchaser_id
  LEFT JOIN ${S}.users au ON au.id = r.approved_by
  LEFT JOIN ${S}.vendors pv ON pv.id = r.proposed_vendor_id
      WHERE r.id = $1`,
    [id]
  );
  if (!req) return null;
  req.items = await query(
    `SELECT * FROM ${S}.requisition_items WHERE requisition_id = $1 ORDER BY sort_order, id`,
    [id]
  );
  const quotes = await query(
    `SELECT q.*, v.name AS vendor_name
       FROM ${S}.requisition_quotes q
       JOIN ${S}.vendors v ON v.id = q.vendor_id
      WHERE q.requisition_id = $1
      ORDER BY q.is_awarded DESC, q.total_amount`,
    [id]
  );
  for (const q of quotes) {
    q.item_rates = {};
    const lines = await query(
      `SELECT requisition_item_id, rate, amount FROM ${S}.requisition_quote_items WHERE quote_id = $1`,
      [q.id]
    );
    for (const l of lines) q.item_rates[l.requisition_item_id] = { rate: l.rate, amount: l.amount };
  }
  req.quotes = quotes;
  req.history = await query(
    `SELECT h.*, u.name AS user_name
       FROM ${S}.requisition_history h
  LEFT JOIN ${S}.users u ON u.id = h.user_id
      WHERE h.requisition_id = $1 ORDER BY h.id`,
    [id]
  );
  return req;
}

async function emailsByRole(...roles) {
  if (!roles.length) return [];
  const ph = roles.map((_, i) => `$${i + 1}`).join(',');
  const rows = await query(
    `SELECT email FROM ${S}.users WHERE active = true AND role IN (${ph}) AND email IS NOT NULL`,
    roles
  );
  return rows.map((r) => r.email);
}

/** Run a notification best-effort — never blocks or breaks the request. */
function fire(factory) {
  Promise.resolve()
    .then(factory)
    // eslint-disable-next-line no-console
    .catch((e) => console.error('[notify]', e && e.message));
}

/* ---------- list & summary ---------- */

// GET /api/requisitions?status=&scope=
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.status) { params.push(req.query.status); clauses.push(`r.status = $${params.length}`); }
    if (req.query.scope === 'mine') { params.push(req.user.id); clauses.push(`r.created_by = $${params.length}`); }
    if (req.query.scope === 'to_source') clauses.push(`r.status = 'submitted'`);
    if (req.query.scope === 'to_approve') clauses.push(`r.status = 'sourced'`);
    if (req.query.scope === 'to_po') clauses.push(`r.status = 'approved'`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await query(
      `SELECT r.id, r.req_number, r.status, r.department, r.party_name, r.request_importance,
              r.created_at, r.requested_by_name, r.expected_inhouse_date,
              pv.name AS proposed_vendor_name,
              (SELECT COUNT(*)::int FROM ${S}.requisition_items i WHERE i.requisition_id = r.id) AS item_count,
              (SELECT total_amount FROM ${S}.requisition_quotes q WHERE q.requisition_id = r.id AND q.is_awarded LIMIT 1) AS awarded_total
         FROM ${S}.requisitions r
    LEFT JOIN ${S}.vendors pv ON pv.id = r.proposed_vendor_id
        ${where}
        ORDER BY r.created_at DESC`,
      params
    );
    res.json({ requisitions: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/requisitions/summary
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const byStatus = await query(
      `SELECT status, COUNT(*)::int AS n FROM ${S}.requisitions GROUP BY status`
    );
    res.json({ byStatus });
  } catch (err) {
    next(err);
  }
});

// GET /api/requisitions/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const requisition = await loadRequisition(req.params.id);
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    res.json({ requisition });
  } catch (err) {
    next(err);
  }
});

/* ---------- create / edit ---------- */

// POST /api/requisitions   (any authenticated user)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items.filter((i) => (i.product_description || '').trim()) : [];
    if (!items.length) return res.status(400).json({ error: 'Add at least one item' });
    const company = await one(`SELECT id FROM ${S}.companies ORDER BY id LIMIT 1`);

    const reqId = await tx(async (c) => {
      const number = await nextReqNumber(c);
      const status = b.submit ? 'submitted' : 'draft';
      const row = await c.one(
        `INSERT INTO ${S}.requisitions
           (req_number, company_id, requested_by, requested_by_name, department, party_name,
            request_importance, payment_mode, required_time, expected_inhouse_date, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$3) RETURNING id`,
        [
          number,
          company ? company.id : null,
          req.user.id,
          (b.requested_by_name || req.user.name || '').trim() || req.user.name,
          (b.department || req.user.department || '').trim() || null,
          (b.party_name || '').trim() || null,
          b.request_importance || 'normal',
          (b.payment_mode || '').trim() || null,
          (b.required_time || '').trim() || null,
          b.expected_inhouse_date || null,
          status,
          (b.notes || '').trim() || null,
        ]
      );
      await writeItems(c, row.id, items);
      await logHistory(c, row.id, 'created', `Requisition ${number} created`, req.user.id);
      if (b.submit) await logHistory(c, row.id, 'submitted', 'Submitted for sourcing', req.user.id);
      return row.id;
    });

    const requisition = await loadRequisition(reqId);
    res.status(201).json({ requisition });
    if (b.submit) fire(async () => notify.submitted(requisition, await emailsByRole('purchaser', 'admin')));
  } catch (err) {
    next(err);
  }
});

// PUT /api/requisitions/:id  (edit a draft — creator or admin)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (r.status !== 'draft') return res.status(409).json({ error: 'Only draft requisitions can be edited' });
    if (r.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only edit your own draft' });
    }
    const b = req.body || {};
    await tx(async (c) => {
      await c.run(
        `UPDATE ${S}.requisitions
            SET department=$1, party_name=$2, request_importance=$3, payment_mode=$4,
                required_time=$5, expected_inhouse_date=$6, notes=$7
          WHERE id=$8`,
        [
          (b.department || '').trim() || null,
          (b.party_name || '').trim() || null,
          b.request_importance || r.request_importance,
          (b.payment_mode || '').trim() || null,
          (b.required_time || '').trim() || null,
          b.expected_inhouse_date || null,
          (b.notes || '').trim() || null,
          r.id,
        ]
      );
      if (Array.isArray(b.items)) await writeItems(c, r.id, b.items);
      await logHistory(c, r.id, 'updated', 'Draft updated', req.user.id);
    });
    res.json({ requisition: await loadRequisition(r.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/requisitions/:id/submit  (draft -> submitted)
router.post('/:id/submit', requireAuth, async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (r.status !== 'draft') return res.status(409).json({ error: 'Only draft requisitions can be submitted' });
    if (r.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only submit your own requisition' });
    }
    await tx(async (c) => {
      await c.run(`UPDATE ${S}.requisitions SET status='submitted' WHERE id=$1`, [r.id]);
      await logHistory(c, r.id, 'submitted', 'Submitted for sourcing', req.user.id);
    });
    const requisition = await loadRequisition(r.id);
    res.json({ requisition });
    fire(async () => notify.submitted(requisition, await emailsByRole('purchaser', 'admin')));
  } catch (err) {
    next(err);
  }
});

/* ---------- purchaser: sourcing / vendor comparison ---------- */

// POST /api/requisitions/:id/source  (purchaser / admin)
router.post('/:id/source', requireRole('purchaser'), async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (!['submitted', 'sourced'].includes(r.status)) {
      return res.status(409).json({ error: 'This requisition is not open for sourcing' });
    }
    const b = req.body || {};
    const quotes = Array.isArray(b.quotes) ? b.quotes : [];
    const awarded = b.awarded_vendor_id;
    if (!quotes.length) return res.status(400).json({ error: 'Add at least one vendor quote' });
    if (!awarded) return res.status(400).json({ error: 'Select the awarded (proposed) vendor' });

    const items = await query(
      `SELECT id, quantity FROM ${S}.requisition_items WHERE requisition_id = $1`,
      [r.id]
    );
    const qtyById = Object.fromEntries(items.map((i) => [i.id, Number(i.quantity) || 0]));

    await tx(async (c) => {
      await c.run(`DELETE FROM ${S}.requisition_quotes WHERE requisition_id = $1`, [r.id]);
      for (const q of quotes) {
        if (!q.vendor_id) continue;
        let total = 0;
        const rates = q.item_rates || {};
        for (const [itemId, rate] of Object.entries(rates)) {
          total += (parseFloat(rate) || 0) * (qtyById[itemId] || 0);
        }
        const isAwarded = String(q.vendor_id) === String(awarded);
        const quoteRow = await c.one(
          `INSERT INTO ${S}.requisition_quotes (requisition_id, vendor_id, is_awarded, total_amount, notes)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [r.id, q.vendor_id, isAwarded, +total.toFixed(2), (q.notes || '').trim() || null]
        );
        for (const [itemId, rate] of Object.entries(rates)) {
          const rt = parseFloat(rate) || 0;
          await c.run(
            `INSERT INTO ${S}.requisition_quote_items (quote_id, requisition_item_id, rate, amount)
             VALUES ($1,$2,$3,$4)`,
            [quoteRow.id, itemId, rt, +(rt * (qtyById[itemId] || 0)).toFixed(2)]
          );
        }
      }
      await c.run(
        `UPDATE ${S}.requisitions
            SET status='sourced', proposed_vendor_id=$1, purchaser_id=$2, purchaser_note=$3
          WHERE id=$4`,
        [awarded, req.user.id, (b.purchaser_note || '').trim() || null, r.id]
      );
      await logHistory(c, r.id, 'sourced', 'Vendor proposed for approval', req.user.id);
    });

    const requisition = await loadRequisition(r.id);
    const awardedQuote = requisition.quotes.find((q) => q.is_awarded);
    requisition.awarded_total_display = awardedQuote ? String(awardedQuote.total_amount) : '';
    res.json({ requisition });
    fire(async () => notify.sourced(requisition, await emailsByRole('approver', 'admin')));
  } catch (err) {
    next(err);
  }
});

/* ---------- owner: final approval ---------- */

// POST /api/requisitions/:id/approve  (approver / admin)
router.post('/:id/approve', requireRole('approver'), async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (r.status !== 'sourced') return res.status(409).json({ error: 'Only sourced requisitions can be approved' });
    const note = (req.body && req.body.note) || null;
    await tx(async (c) => {
      await c.run(
        `UPDATE ${S}.requisitions SET status='approved', approved_by=$1, approved_at=now(), decision_note=$2 WHERE id=$3`,
        [req.user.id, note, r.id]
      );
      await logHistory(c, r.id, 'approved', note || 'Approved for purchase', req.user.id);
    });
    const requisition = await loadRequisition(r.id);
    res.json({ requisition });
    fire(async () => {
      const recips = new Set(await emailsByRole('store', 'admin'));
      const requester = await one(`SELECT email FROM ${S}.users WHERE id = $1`, [r.requested_by]);
      if (requester && requester.email) recips.add(requester.email);
      return notify.decided(requisition, [...recips], true);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/requisitions/:id/reject  (approver / admin)
router.post('/:id/reject', requireRole('approver'), async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (r.status !== 'sourced') return res.status(409).json({ error: 'Only sourced requisitions can be rejected' });
    const note = (req.body && req.body.note) || null;
    await tx(async (c) => {
      await c.run(
        `UPDATE ${S}.requisitions SET status='rejected', approved_by=$1, approved_at=now(), decision_note=$2 WHERE id=$3`,
        [req.user.id, note, r.id]
      );
      await logHistory(c, r.id, 'rejected', note || 'Rejected', req.user.id);
    });
    const requisition = await loadRequisition(r.id);
    res.json({ requisition });
    fire(async () => {
      const requester = await one(`SELECT email FROM ${S}.users WHERE id = $1`, [r.requested_by]);
      return notify.decided(requisition, requester && requester.email ? [requester.email] : [], false);
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- store: PO made ---------- */

// POST /api/requisitions/:id/po-made  (store / admin)
router.post('/:id/po-made', requireRole('store'), async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (r.status !== 'approved') return res.status(409).json({ error: 'Only approved requisitions can be marked PO-made' });
    const ref = (req.body && req.body.po_reference) || null;
    await tx(async (c) => {
      await c.run(`UPDATE ${S}.requisitions SET status='po_made', po_reference=$1 WHERE id=$2`, [ref, r.id]);
      await logHistory(c, r.id, 'po_made', ref ? `PO made (${ref})` : 'PO made in Tally', req.user.id);
    });
    const requisition = await loadRequisition(r.id);
    res.json({ requisition });
    fire(async () => {
      const requester = await one(`SELECT email FROM ${S}.users WHERE id = $1`, [r.requested_by]);
      return notify.poMade(requisition, requester && requester.email ? [requester.email] : []);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/requisitions/:id/cancel
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const r = await one(`SELECT * FROM ${S}.requisitions WHERE id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Requisition not found' });
    if (['approved', 'po_made', 'cancelled'].includes(r.status)) {
      return res.status(409).json({ error: `A ${r.status} requisition cannot be cancelled` });
    }
    if (r.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only cancel your own requisition' });
    }
    await tx(async (c) => {
      await c.run(`UPDATE ${S}.requisitions SET status='cancelled' WHERE id=$1`, [r.id]);
      await logHistory(c, r.id, 'cancelled', (req.body && req.body.note) || 'Cancelled', req.user.id);
    });
    res.json({ requisition: await loadRequisition(r.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
