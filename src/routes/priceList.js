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
  category: 'category', group: 'category', type: 'category',
  item: 'item_name', item_name: 'item_name', itemname: 'item_name', name: 'item_name',
  description: 'item_name', product: 'item_name', commodity: 'item_name', service: 'item_name',
  unit: 'unit', uom: 'unit',
  price: 'price', rate: 'price', amount: 'price', cost: 'price',
  vendor: 'vendor', supplier: 'vendor', party: 'vendor',
  notes: 'notes', remark: 'notes', remarks: 'notes',
};
function normaliseHeader(h) {
  const key = String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
  return HEADER_ALIASES[key] || key;
}

// GET /api/price-list?category=&search=
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.category) { params.push(req.query.category); clauses.push(`p.category = $${params.length}`); }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      clauses.push(`(p.item_name ILIKE $${params.length} OR p.category ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await query(
      `SELECT p.*, v.name AS vendor_name
         FROM ${S}.price_list p
    LEFT JOIN ${S}.vendors v ON v.id = p.vendor_id
        ${where}
        ORDER BY COALESCE(p.category,''), lower(p.item_name)`,
      params
    );
    res.json({ prices: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/price-list/categories
router.get('/categories', requireAuth, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT category, COUNT(*)::int AS n FROM ${S}.price_list
        WHERE category IS NOT NULL AND category <> ''
        GROUP BY category ORDER BY category`
    );
    res.json({ categories: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/price-list/template.csv
router.get('/template.csv', requireAuth, (req, res) => {
  const csv =
    'category,item_name,unit,price,vendor,notes\n' +
    'Transportation,Truck 20ft local,trip,3500,,\n' +
    'Courier,Domestic courier upto 5kg,shipment,250,,\n' +
    'Consumables,A4 Paper Ream,ream,320,,\n' +
    'Freight Forwarding,Sea freight per CBM,cbm,1800,,\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="price-list-template.csv"');
  res.send(csv);
});

// POST /api/price-list  (purchaser / admin)
router.post('/', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    const out = await insertPrice(req.body || {}, req.user.id);
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ price: out.row });
  } catch (err) {
    next(err);
  }
});

// POST /api/price-list/upload  — bulk CSV
router.post('/upload', requireRole('purchaser', 'store'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let records;
    try {
      records = parse(req.file.buffer.toString('utf8'), {
        columns: (h) => h.map(normaliseHeader),
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      });
    } catch (e) {
      return res.status(400).json({ error: `Could not read the file: ${e.message}` });
    }
    if (!records.length) return res.status(400).json({ error: 'The file has no data rows' });
    if (!('item_name' in records[0])) {
      return res.status(400).json({ error: 'Missing an item/name column (e.g. "item_name" or "item").' });
    }
    const summary = { created: 0, skipped: 0, errors: [] };
    const vendorCache = new Map();
    await tx(async (c) => {
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const name = (row.item_name || '').trim();
        if (!name) { summary.skipped += 1; continue; }
        let vendorId = null;
        const vname = (row.vendor || '').trim();
        if (vname) {
          if (vendorCache.has(vname.toLowerCase())) vendorId = vendorCache.get(vname.toLowerCase());
          else {
            let v = await c.one(`SELECT id FROM ${S}.vendors WHERE lower(name)=lower($1)`, [vname]);
            if (!v) v = await c.one(`INSERT INTO ${S}.vendors (name) VALUES ($1) RETURNING id`, [vname]);
            vendorId = v.id;
            vendorCache.set(vname.toLowerCase(), vendorId);
          }
        }
        const price = parseFloat(String(row.price == null ? '' : row.price).replace(/[^0-9.\-]/g, ''));
        await c.run(
          `INSERT INTO ${S}.price_list (category, item_name, unit, price, vendor_id, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            (row.category || '').trim() || null,
            name,
            (row.unit || '').trim() || 'pcs',
            Number.isFinite(price) ? price : 0,
            vendorId,
            (row.notes || '').trim() || null,
            req.user.id,
          ]
        );
        summary.created += 1;
      }
    });
    res.status(201).json({ summary });
  } catch (err) {
    next(err);
  }
});

// PUT /api/price-list/:id
router.put('/:id', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    const existing = await one(`SELECT * FROM ${S}.price_list WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Price not found' });
    const { category, item_name, unit, price, notes, active } = req.body || {};
    const row = await one(
      `UPDATE ${S}.price_list
          SET category=$1, item_name=$2, unit=$3, price=$4, notes=$5, active=$6
        WHERE id=$7 RETURNING *`,
      [
        category !== undefined ? category : existing.category,
        item_name != null ? String(item_name).trim() : existing.item_name,
        unit != null && String(unit).trim() ? String(unit).trim() : existing.unit,
        price !== undefined && price !== '' ? parseFloat(price) || 0 : existing.price,
        notes !== undefined ? notes : existing.notes,
        active !== undefined ? !!active : existing.active,
        req.params.id,
      ]
    );
    res.json({ price: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/price-list/:id
router.delete('/:id', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    await run(`DELETE FROM ${S}.price_list WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

async function insertPrice(body, userId) {
  const name = (body.item_name || '').trim();
  if (!name) return { error: 'Item name is required' };
  let vendorId = body.vendor_id || null;
  const row = await one(
    `INSERT INTO ${S}.price_list (category, item_name, unit, price, vendor_id, notes, effective_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      (body.category || '').trim() || null,
      name,
      (body.unit || '').trim() || 'pcs',
      parseFloat(body.price) || 0,
      vendorId,
      (body.notes || '').trim() || null,
      body.effective_date || null,
      userId,
    ]
  );
  return { row };
}

module.exports = router;
