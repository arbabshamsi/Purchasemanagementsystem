'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// GET /api/suppliers
router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM suppliers ORDER BY active DESC, name COLLATE NOCASE')
    .all();
  res.json({ suppliers: rows });
});

// GET /api/suppliers/:id
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ supplier: row });
});

// POST /api/suppliers
router.post('/', requireRole('staff', 'approver'), (req, res) => {
  const { name, contact_person, email, phone, address } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name is required' });

  const result = db
    .prepare(
      `INSERT INTO suppliers (name, contact_person, email, phone, address)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name.trim(), contact_person || null, email || null, phone || null, address || null);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ supplier });
});

// PUT /api/suppliers/:id
router.put('/:id', requireRole('staff', 'approver'), (req, res) => {
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });

  const { name, contact_person, email, phone, address, active } = req.body || {};
  db.prepare(
    `UPDATE suppliers
        SET name = ?, contact_person = ?, email = ?, phone = ?, address = ?, active = ?
      WHERE id = ?`
  ).run(
    name != null ? String(name).trim() : existing.name,
    contact_person !== undefined ? contact_person : existing.contact_person,
    email !== undefined ? email : existing.email,
    phone !== undefined ? phone : existing.phone,
    address !== undefined ? address : existing.address,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    req.params.id
  );
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  res.json({ supplier });
});

module.exports = router;
