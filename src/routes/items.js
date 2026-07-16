'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// GET /api/items?search=
router.get('/', requireAuth, (req, res) => {
  const search = (req.query.search || '').trim();
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `SELECT * FROM items
          WHERE name LIKE ? OR sku LIKE ? OR category LIKE ?
          ORDER BY active DESC, name COLLATE NOCASE`
      )
      .all(like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM items ORDER BY active DESC, name COLLATE NOCASE').all();
  }
  res.json({ items: rows });
});

// POST /api/items
router.post('/', requireRole('staff', 'approver'), (req, res) => {
  const item = createItem(req.body || {});
  if (item.error) return res.status(400).json({ error: item.error });
  res.status(201).json({ item: item.row });
});

// PUT /api/items/:id
router.put('/:id', requireRole('staff', 'approver'), (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  const { name, sku, unit, category, active } = req.body || {};
  db.prepare(
    'UPDATE items SET name = ?, sku = ?, unit = ?, category = ?, active = ? WHERE id = ?'
  ).run(
    name != null ? String(name).trim() : existing.name,
    sku !== undefined ? sku : existing.sku,
    unit != null && String(unit).trim() ? String(unit).trim() : existing.unit,
    category !== undefined ? category : existing.category,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json({ item: row });
});

/**
 * Insert a single item, reusing an existing row when the name (and SKU, if
 * given) already matches. Returns { row } or { error }.
 */
function createItem({ name, sku, unit, category }) {
  if (!name || !String(name).trim()) return { error: 'Item name is required' };
  const cleanName = String(name).trim();
  const cleanSku = sku ? String(sku).trim() : null;

  const existing = db
    .prepare("SELECT * FROM items WHERE name = ? COLLATE NOCASE AND IFNULL(sku, '') = IFNULL(?, '')")
    .get(cleanName, cleanSku);
  if (existing) return { row: existing, reused: true };

  const result = db
    .prepare('INSERT INTO items (name, sku, unit, category) VALUES (?, ?, ?, ?)')
    .run(cleanName, cleanSku, (unit && String(unit).trim()) || 'pcs', category || null);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
  return { row };
}

module.exports = router;
module.exports.createItem = createItem;
