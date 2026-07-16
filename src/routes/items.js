'use strict';

const express = require('express');
const { query, one, S } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// GET /api/items?search=
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const search = (req.query.search || '').trim();
    let items;
    if (search) {
      const like = `%${search}%`;
      items = await query(
        `SELECT * FROM ${S}.items
          WHERE name ILIKE $1 OR sku ILIKE $1 OR category ILIKE $1
          ORDER BY active DESC, lower(name)`,
        [like]
      );
    } else {
      items = await query(`SELECT * FROM ${S}.items ORDER BY active DESC, lower(name)`);
    }
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /api/items
router.post('/', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const result = await createItem(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ item: result.row });
  } catch (err) {
    next(err);
  }
});

// PUT /api/items/:id
router.put('/:id', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const existing = await one(`SELECT * FROM ${S}.items WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Item not found' });
    const { name, sku, unit, category, active } = req.body || {};
    const item = await one(
      `UPDATE ${S}.items SET name = $1, sku = $2, unit = $3, category = $4, active = $5
        WHERE id = $6 RETURNING *`,
      [
        name != null ? String(name).trim() : existing.name,
        sku !== undefined ? sku : existing.sku,
        unit != null && String(unit).trim() ? String(unit).trim() : existing.unit,
        category !== undefined ? category : existing.category,
        active !== undefined ? !!active : existing.active,
        req.params.id,
      ]
    );
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * Insert an item, reusing an existing row when the name (and SKU, if given)
 * already matches. Returns { row } or { error }. Optionally runs on a
 * transaction-bound client `c` (with the same one/query interface).
 */
async function createItem({ name, sku, unit, category }, c) {
  const q = c ? c.one.bind(c) : one;
  if (!name || !String(name).trim()) return { error: 'Item name is required' };
  const cleanName = String(name).trim();
  const cleanSku = sku ? String(sku).trim() : null;

  const existing = await q(
    `SELECT * FROM ${S}.items WHERE lower(name) = lower($1) AND COALESCE(sku,'') = COALESCE($2,'')`,
    [cleanName, cleanSku]
  );
  if (existing) return { row: existing, reused: true };

  const row = await q(
    `INSERT INTO ${S}.items (name, sku, unit, category) VALUES ($1,$2,$3,$4) RETURNING *`,
    [cleanName, cleanSku, (unit && String(unit).trim()) || 'pcs', category || null]
  );
  return { row };
}

module.exports = router;
module.exports.createItem = createItem;
