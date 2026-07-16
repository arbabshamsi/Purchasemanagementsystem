'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireRole } = require('../auth');

const router = express.Router();

const ROLES = ['admin', 'approver', 'staff'];

// GET /api/users — admin only
router.get('/', requireRole('admin'), (req, res) => {
  const rows = db
    .prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name COLLATE NOCASE')
    .all();
  res.json({ users: rows });
});

// POST /api/users — admin only
router.post('/', requireRole('admin'), (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const cleanEmail = email.trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (exists) return res.status(409).json({ error: 'A user with that email already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name.trim(), cleanEmail, hash, role || 'staff');
  const user = db
    .prepare('SELECT id, name, email, role, active, created_at FROM users WHERE id = ?')
    .get(result.lastInsertRowid);
  res.status(201).json({ user });
});

// PUT /api/users/:id — admin only (update role/active/name/password)
router.put('/:id', requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, role, active, password } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  // Guard against removing the last active admin.
  const demoting = (role && role !== 'admin') || active === false || active === 0;
  if (user.role === 'admin' && demoting) {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1")
      .get().n;
    if (admins <= 1) {
      return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
    }
  }

  const hash = password && password.length >= 6 ? bcrypt.hashSync(password, 10) : user.password_hash;
  db.prepare(
    'UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?'
  ).run(
    name != null ? String(name).trim() : user.name,
    role || user.role,
    active !== undefined ? (active ? 1 : 0) : user.active,
    hash,
    user.id
  );
  const updated = db
    .prepare('SELECT id, name, email, role, active, created_at FROM users WHERE id = ?')
    .get(user.id);
  res.json({ user: updated });
});

module.exports = router;
