'use strict';

const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Absolute path to the SQLite database file.
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pms.db'),

  // Directory where uploaded rate-list files are temporarily stored.
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),

  // Session cookie lifetime in milliseconds (default: 7 days).
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000,

  // Cookie name used to carry the session id.
  sessionCookie: 'pms_sid',

  // Credentials for the initial admin account created on first run.
  // Change these via environment variables in production.
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'System Admin',
    email: (process.env.SEED_ADMIN_EMAIL || 'admin@paramount.local').toLowerCase(),
    password: process.env.SEED_ADMIN_PASSWORD || 'admin123',
  },

  // Maximum accepted upload size for rate-list files (5 MB).
  maxUploadBytes: 5 * 1024 * 1024,
};

module.exports = config;
