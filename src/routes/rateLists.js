'use strict';

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { db } = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../auth');
const { createItem } = require('./items');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

// Column header aliases accepted in an uploaded rate-list file.
const HEADER_ALIASES = {
  item: 'name',
  item_name: 'name',
  itemname: 'name',
  name: 'name',
  product: 'name',
  description: 'name',
  sku: 'sku',
  code: 'sku',
  item_code: 'sku',
  unit: 'unit',
  uom: 'unit',
  category: 'category',
  group: 'category',
  rate: 'rate',
  price: 'rate',
  unit_price: 'rate',
  amount: 'rate',
};

function normaliseHeader(h) {
  const key = String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
  return HEADER_ALIASES[key] || key;
}

/** Load a rate list with its supplier, company and line items. */
function loadRateList(id) {
  const list = db
    .prepare(
      `SELECT rl.*, s.name AS supplier_name, c.name AS company_name, c.code AS company_code
         FROM rate_lists rl
         JOIN suppliers s ON s.id = rl.supplier_id
    LEFT JOIN companies c ON c.id = rl.company_id
        WHERE rl.id = ?`
    )
    .get(id);
  if (!list) return null;
  list.items = db
    .prepare(
      `SELECT rli.id, rli.item_id, rli.rate, COALESCE(rli.unit, i.unit) AS unit,
              i.name AS item_name, i.sku, i.category
         FROM rate_list_items rli
         JOIN items i ON i.id = rli.item_id
        WHERE rli.rate_list_id = ?
        ORDER BY i.name COLLATE NOCASE`
    )
    .all(id);
  return list;
}

// GET /api/rate-lists
router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT rl.*, s.name AS supplier_name, c.name AS company_name,
              (SELECT COUNT(*) FROM rate_list_items x WHERE x.rate_list_id = rl.id) AS item_count
         FROM rate_lists rl
         JOIN suppliers s ON s.id = rl.supplier_id
    LEFT JOIN companies c ON c.id = rl.company_id
        ORDER BY rl.created_at DESC`
    )
    .all();
  res.json({ rateLists: rows });
});

// GET /api/rate-lists/template.csv — downloadable template
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

// GET /api/rate-lists/:id
router.get('/:id', requireAuth, (req, res) => {
  const list = loadRateList(req.params.id);
  if (!list) return res.status(404).json({ error: 'Rate list not found' });
  res.json({ rateList: list });
});

// POST /api/rate-lists — create a rate list, optionally with inline items
router.post('/', requireRole('staff', 'approver'), (req, res) => {
  const { title, supplier_id, company_id, currency, effective_date, notes, items } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });

  const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplier_id);
  if (!supplier) return res.status(400).json({ error: 'Selected supplier does not exist' });

  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO rate_lists (title, supplier_id, company_id, currency, effective_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title.trim(),
        supplier_id,
        company_id || null,
        (currency && String(currency).trim()) || 'PKR',
        effective_date || null,
        notes || null,
        req.user.id
      );
    const listId = result.lastInsertRowid;
    if (Array.isArray(items)) {
      for (const line of items) upsertLineItem(listId, line);
    }
    return listId;
  });

  const listId = tx();
  res.status(201).json({ rateList: loadRateList(listId) });
});

// POST /api/rate-lists/upload — create a rate list from an uploaded CSV file
router.post('/upload', requireRole('staff', 'approver'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { supplier_id, company_id, title, currency, effective_date } = req.body || {};
  if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
  const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(supplier_id);
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
  } catch (err) {
    return res.status(400).json({ error: `Could not read the file: ${err.message}` });
  }

  if (!records.length) return res.status(400).json({ error: 'The file has no data rows' });
  if (!('name' in records[0])) {
    return res.status(400).json({
      error: 'Missing an item name column. Expected a header like "item_name" or "item".',
    });
  }

  const summary = { created: 0, skipped: 0, errors: [] };

  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO rate_lists (title, supplier_id, company_id, currency, effective_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        (title && title.trim()) || `${supplier.name} rate list`,
        supplier_id,
        company_id || null,
        (currency && String(currency).trim()) || 'PKR',
        effective_date || null,
        `Imported from ${req.file.originalname}`,
        req.user.id
      );
    const listId = result.lastInsertRowid;

    records.forEach((row, idx) => {
      const name = (row.name || '').trim();
      if (!name) {
        summary.skipped += 1;
        return;
      }
      const rate = parseFloat(String(row.rate ?? '').replace(/[^0-9.\-]/g, ''));
      const created = createItem({
        name,
        sku: row.sku,
        unit: row.unit,
        category: row.category,
      });
      if (created.error) {
        summary.errors.push(`Row ${idx + 2}: ${created.error}`);
        summary.skipped += 1;
        return;
      }
      upsertLineItem(listId, {
        item_id: created.row.id,
        rate: Number.isFinite(rate) ? rate : 0,
        unit: row.unit,
      });
      summary.created += 1;
    });
    return listId;
  });

  const listId = tx();
  res.status(201).json({ rateList: loadRateList(listId), summary });
});

// POST /api/rate-lists/:id/items — add or update a single line rate
router.post('/:id/items', requireRole('staff', 'approver'), (req, res) => {
  const list = db.prepare('SELECT id FROM rate_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Rate list not found' });
  const out = upsertLineItem(req.params.id, req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  res.status(201).json({ rateList: loadRateList(req.params.id) });
});

// DELETE /api/rate-lists/:id/items/:lineId
router.delete('/:id/items/:lineId', requireRole('staff', 'approver'), (req, res) => {
  db.prepare('DELETE FROM rate_list_items WHERE id = ? AND rate_list_id = ?').run(
    req.params.lineId,
    req.params.id
  );
  res.json({ rateList: loadRateList(req.params.id) });
});

// DELETE /api/rate-lists/:id
router.delete('/:id', requireRole('approver'), (req, res) => {
  db.prepare('DELETE FROM rate_lists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/rate-lists/supplier/:supplierId/rates — effective rates for PO auto-fill
router.get('/supplier/:supplierId/rates', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.name AS item_name, i.sku,
              COALESCE(rli.unit, i.unit) AS unit,
              rli.rate, rl.id AS rate_list_id, rl.title AS rate_list_title
         FROM rate_list_items rli
         JOIN rate_lists rl ON rl.id = rli.rate_list_id
         JOIN items i ON i.id = rli.item_id
        WHERE rl.supplier_id = ? AND rl.status = 'active'
        ORDER BY i.name COLLATE NOCASE, rl.created_at DESC`
    )
    .all(req.params.supplierId);

  // Keep only the most recent rate per item.
  const seen = new Set();
  const rates = [];
  for (const r of rows) {
    if (seen.has(r.item_id)) continue;
    seen.add(r.item_id);
    rates.push(r);
  }
  res.json({ rates });
});

/**
 * Insert or update a rate line. Accepts either an existing item_id or a new
 * item defined by item_name/sku/unit/category. Returns { line } or { error }.
 */
function upsertLineItem(listId, line) {
  let itemId = line.item_id;
  if (!itemId) {
    if (!line.item_name && !line.name) return { error: 'Item name or item_id is required' };
    const created = createItem({
      name: line.item_name || line.name,
      sku: line.sku,
      unit: line.unit,
      category: line.category,
    });
    if (created.error) return { error: created.error };
    itemId = created.row.id;
  }
  const rate = parseFloat(line.rate);
  db.prepare(
    `INSERT INTO rate_list_items (rate_list_id, item_id, rate, unit)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(rate_list_id, item_id)
     DO UPDATE SET rate = excluded.rate, unit = excluded.unit`
  ).run(listId, itemId, Number.isFinite(rate) ? rate : 0, line.unit || null);
  return { ok: true };
}

module.exports = router;
