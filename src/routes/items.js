'use strict';

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { query, one, run, tx, S } = require('../db');
const config = require('../config');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

const HEADER_ALIASES = {
  code: 'code', item_code: 'code', sku: 'code',
  category: 'category', group: 'category', type: 'category',
  item: 'name', item_name: 'name', itemname: 'name', name: 'name', description: 'name', product: 'name',
  unit: 'unit', uom: 'unit',
  notes: 'notes', remark: 'notes', remarks: 'notes',
};
function normaliseHeader(h) {
  const key = String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
  return HEADER_ALIASES[key] || key;
}

// GET /api/items?search=&category=
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.category) { params.push(req.query.category); clauses.push(`category = $${params.length}`); }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      clauses.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length} OR category ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const items = await query(
      `SELECT * FROM ${S}.item_master ${where} ORDER BY active DESC, COALESCE(category,''), lower(name)`,
      params
    );
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// GET /api/items/categories
router.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const categories = await query(
      `SELECT category, COUNT(*)::int AS n FROM ${S}.item_master
        WHERE category IS NOT NULL AND category <> '' GROUP BY category ORDER BY category`
    );
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

// GET /api/items/template.csv
router.get('/template.csv', requireAuth, (req, res) => {
  const csv =
    'code,category,item_name,unit,notes\n' +
    'MCB-4W,Electrical,MCB Box 4 way,pc,\n' +
    'WIRE-25,Electrical,Wire 2.5mm poly cab,coil (500m),\n' +
    'TRK-20,Transportation,Truck 20ft (local),trip,\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="item-master-template.csv"');
  res.send(csv);
});

// POST /api/items  (purchaser / store / admin)
router.post('/', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    const out = await upsertItem(req.body || {}, req.user.id);
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ item: out.row });
  } catch (err) {
    next(err);
  }
});

// POST /api/items/upload  — bulk CSV
router.post('/upload', requireRole('purchaser', 'store'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let records;
    try {
      records = parse(req.file.buffer.toString('utf8'), {
        columns: (h) => h.map(normaliseHeader),
        skip_empty_lines: true, trim: true, relax_column_count: true, bom: true,
      });
    } catch (e) {
      return res.status(400).json({ error: `Could not read the file: ${e.message}` });
    }
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows' });
    if (!('name' in records[0])) {
      return res.status(400).json({ error: 'Missing an item/name column (e.g. "item_name" or "item").' });
    }
    const summary = { created: 0, updated: 0, skipped: 0 };
    await tx(async (c) => {
      for (const row of records) {
        const name = (row.name || '').trim();
        if (!name) { summary.skipped += 1; continue; }
        const existing = await c.one(`SELECT id FROM ${S}.item_master WHERE lower(name) = lower($1)`, [name]);
        if (existing) {
          await c.run(
            `UPDATE ${S}.item_master SET code=$1, category=$2, unit=$3, notes=$4 WHERE id=$5`,
            [(row.code || '').trim() || null, (row.category || '').trim() || null,
             (row.unit || '').trim() || 'pcs', (row.notes || '').trim() || null, existing.id]
          );
          summary.updated += 1;
        } else {
          await c.run(
            `INSERT INTO ${S}.item_master (code, category, name, unit, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
            [(row.code || '').trim() || null, (row.category || '').trim() || null, name,
             (row.unit || '').trim() || 'pcs', (row.notes || '').trim() || null, req.user.id]
          );
          summary.created += 1;
        }
      }
    });
    res.status(201).json({ summary });
  } catch (err) {
    next(err);
  }
});

// PUT /api/items/:id
router.put('/:id', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    const existing = await one(`SELECT * FROM ${S}.item_master WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    const { code, name, category, unit, notes, active } = req.body || {};
    const item = await one(
      `UPDATE ${S}.item_master SET code=$1, name=$2, category=$3, unit=$4, notes=$5, active=$6 WHERE id=$7 RETURNING *`,
      [
        code !== undefined ? (String(code).trim() || null) : existing.code,
        name != null ? String(name).trim() : existing.name,
        category !== undefined ? (String(category).trim() || null) : existing.category,
        unit != null && String(unit).trim() ? String(unit).trim() : existing.unit,
        notes !== undefined ? notes : existing.notes,
        active !== undefined ? !!active : existing.active,
        req.params.id,
      ]
    );
    res.json({ item });
  } catch (err) {
    if (err.message && /uq_.*item_master_name|duplicate key/.test(err.message)) {
      return res.status(409).json({ error: 'An item with that name already exists' });
    }
    next(err);
  }
});

// DELETE /api/items/:id
router.delete('/:id', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    await run(`DELETE FROM ${S}.item_master WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

async function upsertItem(body, userId) {
  const name = (body.name || body.item_name || '').trim();
  if (!name) return { error: 'Item name is required' };
  const existing = await one(`SELECT id FROM ${S}.item_master WHERE lower(name) = lower($1)`, [name]);
  if (existing) return { error: 'An item with that name already exists' };
  const row = await one(
    `INSERT INTO ${S}.item_master (code, category, name, unit, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [(body.code || '').trim() || null, (body.category || '').trim() || null, name,
     (body.unit || '').trim() || 'pcs', (body.notes || '').trim() || null, userId]
  );
  return { row };
}

module.exports = router;
