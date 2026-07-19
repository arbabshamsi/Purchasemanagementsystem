'use strict';

const express = require('express');
const { query, one, S } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// GET /api/vendors
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const vendors = await query(`SELECT * FROM ${S}.vendors ORDER BY active DESC, lower(name)`);
    res.json({ vendors });
  } catch (err) {
    next(err);
  }
});

// POST /api/vendors  (purchaser / admin)
router.post('/', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    const { name, contact_person, phone, email, address, gst_number } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Vendor name is required' });
    const vendor = await one(
      `INSERT INTO ${S}.vendors (name, contact_person, phone, email, address, gst_number)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), contact_person || null, phone || null, email || null, address || null, gst_number || null]
    );
    res.status(201).json({ vendor });
  } catch (err) {
    next(err);
  }
});

// PUT /api/vendors/:id
router.put('/:id', requireRole('purchaser', 'store'), async (req, res, next) => {
  try {
    const existing = await one(`SELECT * FROM ${S}.vendors WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });
    const { name, contact_person, phone, email, address, gst_number, active } = req.body || {};
    const vendor = await one(
      `UPDATE ${S}.vendors
          SET name=$1, contact_person=$2, phone=$3, email=$4, address=$5, gst_number=$6, active=$7
        WHERE id=$8 RETURNING *`,
      [
        name != null ? String(name).trim() : existing.name,
        contact_person !== undefined ? contact_person : existing.contact_person,
        phone !== undefined ? phone : existing.phone,
        email !== undefined ? email : existing.email,
        address !== undefined ? address : existing.address,
        gst_number !== undefined ? gst_number : existing.gst_number,
        active !== undefined ? !!active : existing.active,
        req.params.id,
      ]
    );
    res.json({ vendor });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
