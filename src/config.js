'use strict';

// Central configuration, all overridable via environment variables.
const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Postgres connection string (Supabase in production).
  // Example: postgresql://user:pass@host:6543/postgres
  databaseUrl: process.env.DATABASE_URL || '',

  // All tables live in this schema so the app never collides with other
  // applications sharing the same database.
  dbSchema: process.env.DB_SCHEMA || 'pms',

  // Session cookie lifetime (default 7 days).
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000,
  sessionCookie: 'pms_sid',

  // First admin account, created automatically on first run.
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'System Admin',
    email: (process.env.SEED_ADMIN_EMAIL || 'admin@paramount.local').toLowerCase(),
    password: process.env.SEED_ADMIN_PASSWORD || 'admin123',
  },

  // Max accepted rate-list upload size (5 MB).
  maxUploadBytes: 5 * 1024 * 1024,
};

module.exports = config;
