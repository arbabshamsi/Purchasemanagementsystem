'use strict';

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { query, one, run, tx, S } = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../auth');
const { createItem } = require('./items');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

// Accepted header aliases in an uploaded rate-list file.
const HEADER_ALIASES = {
  item: 'name', item_name: 'name', itemname: 'name', name: 'name',
  product: 'name', description: 'name',
  sku: 'sku', code: 'sku', item_code: 'sku',
  unit: 'unit', uom: 'unit',
  category: 'category', group: 'category',
  rate: 'rate', price: 'rate', unit_price: 'rate', amount: 'rate',
};
function normaliseHeader(hdr) {
  const key = String(hdr || '').trim().toLowerCase().replace(/\s+/g, '_');
  return HEADER_ALIASES[key] || key;
}

/** Load a rate list with supplier, company and line items. */
async function loadRateList(id) {
  const list = await one(
    `SELECT rl.*, s.name AS supplier_name, c.name AS company_name, c.code AS company_code
       FROM ${S}.rate_lists rl
       JOIN ${S}.suppliers s ON s.id = rl.supplier_id
  LEFT JOIN ${S}.companies c ON c.id = rl.company_id
      WHERE rl.id = $1`,
    [id]
  );
  if (!list) return null;
  list.items = await query(
    `SELECT rli.id, rli.item_id, rli.rate, COALESCE(rli.unit, i.unit) AS unit,
            i.name AS item_name, i.sku, i.category
       FROM ${S}.rate_list_items rli
       JOIN ${S}.items i ON i.id = rli.item_id
      WHERE rli.rate_list_id = $1
      ORDER BY lower(i.name)`,
    [id]
  );
  return list;
}

/** Insert/update a rate line. `c` is an optional transaction-bound helper. */
async function upsertLineItem(listId, line, c) {
  const runner = c || { one, run };
  let itemId = line.item_id;
  if (!itemId) {
    if (!line.item_name && !line.name) return { error: 'Item name or item_id is required' };
    const created = await createItem(
      { name: line.item_name || line.name, sku: line.sku, unit: line.unit, category: line.category },
      c
    );
    if (created.error) return { error: created.error };
    itemId = created.row.id;
  }
  const rate = parseFloat(line.rate);
  await runner.run(
    `INSERT INTO ${S}.rate_list_items (rate_list_id, item_id, rate, unit)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (rate_list_id, item_id)
     DO UPDATE SET rate = EXCLUDED.rate, unit = EXCLUDED.unit`,
    [listId, itemId, Number.isFinite(rate) ? rate : 0, line.unit || null]
  );
  return { ok: true };
}

// GET /api/rate-lists
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rateLists = await query(
      `SELECT rl.*, s.name AS supplier_name, c.name AS company_name,
              (SELECT COUNT(*)::int FROM ${S}.rate_list_items x WHERE x.rate_list_id = rl.id) AS item_count
         FROM ${S}.rate_lists rl
         JOIN ${S}.suppliers s ON s.id = rl.supplier_id
    LEFT JOIN ${S}.companies c ON c.id = rl.company_id
        ORDER BY rl.created_at DESC`
    );
    res.json({ rateLists });
  } catch (err) {
    next(err);
  }
});

// GET /api/rate-lists/template.csv (must precede /:id)
router.get('/template.csv', requireAuth, (req, res) => {
  const csv =
    'item_name,sku,unit,category,rate\n' +
    'Ceramic Dinner Plate 10in,PLT-10,pcs,Tableware,320\n' +
    'Stainless Steel Spoon,SPN-01,dozen,Cutlery,540\n' +
    'Cotton Bath Towel,TWL-BATH,pcs,Linen,850\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="rate-list-template.csv"');
  res.send(csv);
});

// GET /api/rate-lists/supplier/:supplierId/rates — effective rates for PO auto-fill
router.get('/supplier/:supplierId/rates', requireAuth, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT i.id AS item_id, i.name AS item_name, i.sku,
              COALESCE(rli.unit, i.unit) AS unit, rli.rate,
              rl.id AS rate_list_id, rl.title AS rate_list_title, rl.created_at
         FROM ${S}.rate_list_items rli
         JOIN ${S}.rate_lists rl ON rl.id = rli.rate_list_id
         JOIN ${S}.items i ON i.id = rli.item_id
        WHERE rl.supplier_id = $1 AND rl.status = 'active'
        ORDER BY lower(i.name), rl.created_at DESC`,
      [req.params.supplierId]
    );
    const seen = new Set();
    const rates = [];
    for (const r of rows) {
      if (seen.has(r.item_id)) continue;
      seen.add(r.item_id);
      rates.push(r);
    }
    res.json({ rates });
  } catch (err) {
    next(err);
  }
});

// GET /api/rate-lists/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const rateList = await loadRateList(req.params.id);
    if (!rateList) return res.status(404).json({ error: 'Rate list not found' });
    res.json({ rateList });
  } catch (err) {
    next(err);
  }
});

// POST /api/rate-lists — create a rate list, optionally with inline items
router.post('/', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const { title, supplier_id, company_id, currency, effective_date, notes, items } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
    const supplier = await one(`SELECT id FROM ${S}.suppliers WHERE id = $1`, [supplier_id]);
    if (!supplier) return res.status(400).json({ error: 'Selected supplier does not exist' });

    const listId = await tx(async (c) => {
      const list = await c.one(
        `INSERT INTO ${S}.rate_lists (title, supplier_id, company_id, currency, effective_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          title.trim(), supplier_id, company_id || null,
          (currency && String(currency).trim()) || 'PKR',
          effective_date || null, notes || null, req.user.id,
        ]
      );
      if (Array.isArray(items)) {
        for (const line of items) await upsertLineItem(list.id, line, c);
      }
      return list.id;
    });
    res.status(201).json({ rateList: await loadRateList(listId) });
  } catch (err) {
    next(err);
  }
});

// POST /api/rate-lists/upload — create a rate list from an uploaded CSV
router.post('/upload', requireRole('staff', 'approver'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { supplier_id, company_id, title, currency, effective_date } = req.body || {};
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
    const supplier = await one(`SELECT id, name FROM ${S}.suppliers WHERE id = $1`, [supplier_id]);
    if (!supplier) return res.status(400).json({ error: 'Selected supplier does not exist' });

    let records;
    try {
      records = parse(req.file.buffer.toString('utf8'), {
        columns: (headers) => headers.map(normaliseHeader),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      });
    } catch (e) {
      return res.status(400).json({ error: `Could not read the file: ${e.message}` });
    }
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows' });
    if (!('name' in records[0])) {
      return res.status(400).json({
        error: 'Missing an item name column. Expected a header like "item_name" or "item".',
      });
    }

    const summary = { created: 0, skipped: 0, errors: [] };
    const listId = await tx(async (c) => {
      const list = await c.one(
        `INSERT INTO ${S}.rate_lists (title, supplier_id, company_id, currency, effective_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          (title && title.trim()) || `${supplier.name} rate list`,
          supplier_id, company_id || null,
          (currency && String(currency).trim()) || 'PKR',
          effective_date || null, `Imported from ${req.file.originalname}`, req.user.id,
        ]
      );
      for (let idx = 0; idx < records.length; idx++) {
        const row = records[idx];
        const name = (row.name || '').trim();
        if (!name) { summary.skipped += 1; continue; }
        const rate = parseFloat(String(row.rate == null ? '' : row.rate).replace(/[^0-9.\-]/g, ''));
        const created = await createItem(
          { name, sku: row.sku, unit: row.unit, category: row.category }, c
        );
        if (created.error) { summary.errors.push(`Row ${idx + 2}: ${created.error}`); summary.skipped += 1; continue; }
        await upsertLineItem(list.id, { item_id: created.row.id, rate: Number.isFinite(rate) ? rate : 0, unit: row.unit }, c);
        summary.created += 1;
      }
      return list.id;
    });
    res.status(201).json({ rateList: await loadRateList(listId), summary });
  } catch (err) {
    next(err);
  }
});

// POST /api/rate-lists/:id/items — add or update a single line rate
router.post('/:id/items', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const list = await one(`SELECT id FROM ${S}.rate_lists WHERE id = $1`, [req.params.id]);
    if (!list) return res.status(404).json({ error: 'Rate list not found' });
    const out = await upsertLineItem(req.params.id, req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ rateList: await loadRateList(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rate-lists/:id/items/:lineId
router.delete('/:id/items/:lineId', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    await run(`DELETE FROM ${S}.rate_list_items WHERE id = $1 AND rate_list_id = $2`, [
      req.params.lineId, req.params.id,
    ]);
    res.json({ rateList: await loadRateList(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/rate-lists/:id
router.delete('/:id', requireRole('approver'), async (req, res, next) => {
  try {
    await run(`DELETE FROM ${S}.rate_lists WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
