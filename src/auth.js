'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, one, run, S } = require('./db');
const config = require('./config');

/** Create a session for a user and return the opaque token. */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await run(
    `INSERT INTO ${S}.sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
    [token, userId, expiresAt]
  );
  return token;
}

async function destroySession(token) {
  if (!token) return;
  await run(`DELETE FROM ${S}.sessions WHERE token = $1`, [token]);
}

/** Resolve a user from a valid, unexpired session token, or null. */
async function userFromToken(token) {
  if (!token) return null;
  const row = await one(
    `SELECT u.id, u.name, u.email, u.role, u.active
       FROM ${S}.sessions s
       JOIN ${S}.users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at >= now()`,
    [token]
  );
  if (!row || !row.active) return null;
  return row;
}

/** Verify email + password; returns the user (without hash) or null. */
async function verifyLogin(email, password) {
  const user = await one(
    `SELECT * FROM ${S}.users WHERE email = $1 AND active = true`,
    [String(email || '').trim().toLowerCase()]
  );
  if (!user) return null;
  if (!bcrypt.compareSync(password || '', user.password_hash)) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/** Attach req.user when a valid session cookie is present (never rejects). */
async function attachUser(req, res, next) {
  try {
    const token = req.cookies ? req.cookies[config.sessionCookie] : null;
    req.sessionToken = token || null;
    req.user = await userFromToken(token);
  } catch (err) {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

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
