'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');

/** Create a session for a user and return the opaque token. */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMs)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, userId, expiresAt);
  return token;
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Look up a user by a valid, unexpired session token. Returns null if none. */
function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
          AND s.expires_at >= datetime('now')`
    )
    .get(token);
  if (!row || !row.active) return null;
  return row;
}

/** Verify email + password and return the user record (without hash) or null. */
function verifyLogin(email, password) {
  const user = db
    .prepare('SELECT * FROM users WHERE email = ? AND active = 1')
    .get(String(email || '').trim().toLowerCase());
  if (!user) return null;
  if (!bcrypt.compareSync(password || '', user.password_hash)) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/**
 * Express middleware that attaches req.user when a valid session cookie is
 * present. Never rejects — route guards decide what to do when req.user is null.
 */
function attachUser(req, res, next) {
  const token = req.cookies ? req.cookies[config.sessionCookie] : null;
  req.sessionToken = token || null;
  req.user = userFromToken(token);
  next();
}

/** Guard requiring an authenticated user. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

/** Guard requiring one of the given roles (admin always allowed). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'You do not have permission to do this' });
  };
}

function setSessionCookie(res, token) {
  res.cookie(config.sessionCookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    maxAge: config.sessionTtlMs,
  });
}

module.exports = {
  createSession,
  destroySession,
  userFromToken,
  verifyLogin,
  attachUser,
  requireAuth,
  requireRole,
  setSessionCookie,
};
