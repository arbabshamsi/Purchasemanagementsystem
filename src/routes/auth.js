'use strict';

const express = require('express');
const auth = require('../auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = auth.verifyLogin(email, password);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({ user });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  res.clearCookie(require('../config').sessionCookie);
  res.json({ ok: true });
});

// GET /api/auth/me — current session's user (or null)
router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

module.exports = router;
