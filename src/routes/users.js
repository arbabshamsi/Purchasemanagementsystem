'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, one, run, S } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();
const ROLES = ['admin', 'approver', 'staff'];

// GET /api/users
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const users = await query(
      `SELECT id, name, email, role, active, created_at FROM ${S}.users ORDER BY lower(name)`
    );
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// POST /api/users
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const cleanEmail = email.trim().toLowerCase();
    const exists = await one(`SELECT id FROM ${S}.users WHERE email = $1`, [cleanEmail]);
    if (exists) return res.status(409).json({ error: 'A user with that email already exists' });
    const hash = bcrypt.hashSync(password, 10);
    const user = await one(
      `INSERT INTO ${S}.users (name, email, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id, name, email, role, active, created_at`,
      [name.trim(), cleanEmail, hash, role || 'staff']
    );
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const user = await one(`SELECT * FROM ${S}.users WHERE id = $1`, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { name, role, active, password } = req.body || {};
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const demoting = (role && role !== 'admin') || active === false || active === 0;
    if (user.role === 'admin' && demoting) {
      const admins = await one(`SELECT COUNT(*)::int AS n FROM ${S}.users WHERE role = 'admin' AND active = true`);
      if (admins.n <= 1) return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
    }

    const hash = password && password.length >= 6 ? bcrypt.hashSync(password, 10) : user.password_hash;
    const updated = await one(
      `UPDATE ${S}.users SET name = $1, role = $2, active = $3, password_hash = $4
        WHERE id = $5 RETURNING id, name, email, role, active, created_at`,
      [
        name != null ? String(name).trim() : user.name,
        role || user.role,
        active !== undefined ? !!active : user.active,
        hash,
        user.id,
      ]
    );
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
