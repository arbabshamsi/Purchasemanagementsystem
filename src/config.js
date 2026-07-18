'use strict';

// Central configuration, all overridable via environment variables.
const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // --- Database connection ---
  // Two supported ways to configure the Postgres (Supabase) connection:
  //
  // A) Simple: give the app your Supabase URL + database password as two
  //    separate variables, and it builds the connection itself:
  //      NEXT_PUBLIC_SUPABASE_URL = https://<ref>.supabase.co   (you already have this)
  //      SUPABASE_DB_PASSWORD     = your database password       (add this one)
  //    The pooler host/port/user are derived automatically.
  //
  // B) Advanced: provide a full connection string in DATABASE_URL, which
  //    overrides A). Used for local development.
  databaseUrl: process.env.DATABASE_URL || '',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  // Preferred in production: Supabase URL + service-role key (no DB password
  // needed). The app talks to the database through SECURITY DEFINER RPCs.
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  supabaseDbPassword: process.env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_PASSWORD || '',
  // Region of the Supabase project (used to build the pooler hostname).
  supabaseRegion: process.env.SUPABASE_REGION || 'ap-northeast-2',
  // Optional explicit overrides for the connection pooler.
  supabasePoolerHost: process.env.SUPABASE_POOLER_HOST || '',
  supabasePoolerPort: parseInt(process.env.SUPABASE_POOLER_PORT, 10) || 6543,

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
