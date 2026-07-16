'use strict';

const express = require('express');
const { query, one, run, S } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// GET /api/suppliers
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const suppliers = await query(
      `SELECT * FROM ${S}.suppliers ORDER BY active DESC, lower(name)`
    );
    res.json({ suppliers });
  } catch (err) {
    next(err);
  }
});

// GET /api/suppliers/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const supplier = await one(`SELECT * FROM ${S}.suppliers WHERE id = $1`, [req.params.id]);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ supplier });
  } catch (err) {
    next(err);
  }
});

// POST /api/suppliers
router.post('/', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const { name, contact_person, email, phone, address } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name is required' });
    const supplier = await one(
      `INSERT INTO ${S}.suppliers (name, contact_person, email, phone, address)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), contact_person || null, email || null, phone || null, address || null]
    );
    res.status(201).json({ supplier });
  } catch (err) {
    next(err);
  }
});

// PUT /api/suppliers/:id
router.put('/:id', requireRole('staff', 'approver'), async (req, res, next) => {
  try {
    const existing = await one(`SELECT * FROM ${S}.suppliers WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });
    const { name, contact_person, email, phone, address, active } = req.body || {};
    const supplier = await one(
      `UPDATE ${S}.suppliers
          SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, active = $6
        WHERE id = $7 RETURNING *`,
      [
        name != null ? String(name).trim() : existing.name,
        contact_person !== undefined ? contact_person : existing.contact_person,
        email !== undefined ? email : existing.email,
        phone !== undefined ? phone : existing.phone,
        address !== undefined ? address : existing.address,
        active !== undefined ? !!active : existing.active,
        req.params.id,
      ]
    );
    res.json({ supplier });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
