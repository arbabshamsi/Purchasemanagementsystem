'use strict';

const express = require('express');
const auth = require('../auth');
const config = require('../config');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const user = await auth.verifyLogin(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const token = await auth.createSession(user.id);
    auth.setSessionCookie(res, token);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    await auth.destroySession(req.sessionToken);
    res.clearCookie(config.sessionCookie);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

module.exports = router;
