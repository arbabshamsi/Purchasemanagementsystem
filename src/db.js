'use strict';

const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const config = require('./config');

// ---- Type parsers: return JS-friendly values from Postgres ----
// bigint / int8  -> number (safe for our id ranges; makes COUNT(*) a number too)
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
// numeric        -> float (money/quantities as numbers, not strings)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// date           -> keep the raw 'YYYY-MM-DD' string (avoids timezone shifts)
types.setTypeParser(1082, (v) => v);

const S = config.dbSchema; // schema name, e.g. "pms"

/** Extract the project ref from a Supabase URL (https://<ref>.supabase.co). */
function extractRef(url) {
  const m = String(url || '').match(/https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i);
  return m ? m[1] : '';
}

/**
 * Build the list of candidate connection strings to try, in order.
 * - If DATABASE_URL is set, use it (local dev / manual override).
 * - Otherwise build the Supabase transaction-pooler URL from the project ref
 *   (taken from the Supabase URL) + the database password. The pooler host can
 *   be either aws-0-<region> or aws-1-<region>, so both are tried.
 * The password is URL-encoded, so special characters are always safe.
 */
function connectionCandidates() {
  if (config.supabaseDbPassword) {
    const ref = extractRef(config.supabaseUrl);
    if (!ref) {
      throw new Error(
        'SUPABASE_DB_PASSWORD is set but the Supabase URL is missing/invalid. ' +
          'Set NEXT_PUBLIC_SUPABASE_URL to https://<ref>.supabase.co'
      );
    }
    const pw = encodeURIComponent(config.supabaseDbPassword);
    const port = config.supabasePoolerPort;
    const hosts = config.supabasePoolerHost
      ? [config.supabasePoolerHost]
      : [
          `aws-0-${config.supabaseRegion}.pooler.supabase.com`,
          `aws-1-${config.supabaseRegion}.pooler.supabase.com`,
        ];
    return hosts.map((h) => `postgresql://postgres.${ref}:${pw}@${h}:${port}/postgres`);
  }
  if (config.databaseUrl) return [config.databaseUrl];
  return [];
}

let poolPromise = null;

/** Lazily create (and cache) the connection pool, picking a host that works. */
function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    const candidates = connectionCandidates();
    if (!candidates.length) {
      throw new Error('No database configured. Set SUPABASE_DB_PASSWORD (+ Supabase URL) or DATABASE_URL.');
    }
    let lastErr;
    for (const connectionString of candidates) {
      const local = /localhost|127\.0\.0\.1|::1/.test(connectionString);
      const candidate = new Pool({
        connectionString,
        ssl: local ? false : { rejectUnauthorized: false },
        max: parseInt(process.env.PG_POOL_MAX, 10) || 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 15000,
      });
      try {
        await candidate.query('SELECT 1');
        return candidate; // this connection string works
      } catch (err) {
        lastErr = err;
        await candidate.end().catch(() => {});
      }
    }
    poolPromise = null; // let a later request retry
    throw lastErr || new Error('Could not connect to the database');
  })();
  return poolPromise;
}

// ---- Transport selection ----
// Production: Supabase URL + service-role key -> talk to the database through
// the SECURITY DEFINER RPCs (no DB password / connection string needed).
// Local dev: a Postgres connection string (DATABASE_URL) or SUPABASE_DB_PASSWORD.
const useClient = !!(config.supabaseUrl && config.supabaseServiceKey);

let supabaseClient = null;
function getClient() {
  if (!supabaseClient) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

async function rpcRows(text, params) {
  const { data, error } = await getClient().rpc('pms_exec_rows', {
    query: text,
    params: params || [],
  });
  if (error) throw new Error(error.message || 'Database error');
  return data || [];
}
async function rpcRun(text, params) {
  const { data, error } = await getClient().rpc('pms_exec_run', {
    query: text,
    params: params || [],
  });
  if (error) throw new Error(error.message || 'Database error');
  return { rowCount: typeof data === 'number' ? data : 0 };
}

/** Run a query and return the rows. */
async function query(text, params) {
  if (useClient) return rpcRows(text, params);
  const p = await getPool();
  const res = await p.query(text, params);
  return res.rows;
}
/** Run a query and return the first row (or null). */
async function one(text, params) {
  if (useClient) {
    const rows = await rpcRows(text, params);
    return rows[0] || null;
  }
  const p = await getPool();
  const res = await p.query(text, params);
  return res.rows[0] || null;
}
/** Run a query and return the raw result (rowCount, etc.). */
async function run(text, params) {
  if (useClient) return rpcRun(text, params);
  const p = await getPool();
  return p.query(text, params);
}

/**
 * Run `fn` inside a transaction. `fn` receives a helper with the same
 * query/one/run interface.
 *
 * With Postgres (local): a real BEGIN/COMMIT transaction on one connection.
 * With the Supabase client: PostgREST is stateless, so statements run
 * sequentially (not wrapped in one transaction). The application logic is the
 * same; only cross-statement atomicity differs.
 */
async function tx(fn) {
  if (useClient) {
    return fn({ query, one, run });
  }
  const p = await getPool();
  const client = await p.connect();
  const helper = {
    query: async (t, pr) => (await client.query(t, pr)).rows,
    one: async (t, pr) => (await client.query(t, pr)).rows[0] || null,
    run: (t, pr) => client.query(t, pr),
  };
  try {
    await client.query('BEGIN');
    const out = await fn(helper);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Idempotent schema definition. Safe to run on every cold start.
const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS ${S};

CREATE TABLE IF NOT EXISTS ${S}.users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'staff'
                     CHECK (role IN ('admin','approver','purchaser','store','staff')),
  department    text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.sessions (
  token      text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.companies (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  code       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Vendors (suppliers we buy from).
CREATE TABLE IF NOT EXISTS ${S}.vendors (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,
  contact_person text, phone text, email text, address text, gst_number text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Master price list: prices for every commodity/service (transport, courier,
-- consumables, non-consumables, freight, etc.). Optionally tied to a vendor.
CREATE TABLE IF NOT EXISTS ${S}.price_list (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category       text,
  item_name      text NOT NULL,
  unit           text NOT NULL DEFAULT 'pcs',
  price          numeric(14,2) NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'INR',
  vendor_id      bigint REFERENCES ${S}.vendors(id) ON DELETE SET NULL,
  notes          text,
  effective_date date,
  active         boolean NOT NULL DEFAULT true,
  created_by     bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Item master: the catalogue of items/commodities everyone picks from.
CREATE TABLE IF NOT EXISTS ${S}.item_master (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       text,
  name       text NOT NULL,
  category   text,
  unit       text NOT NULL DEFAULT 'pcs',
  notes      text,
  active     boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Requisitions (the digital slip). Flow:
-- draft -> submitted (to purchaser) -> sourced (vendor proposed) ->
-- approved (final) / rejected -> po_made -> cancelled.
CREATE TABLE IF NOT EXISTS ${S}.requisitions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  req_number         text NOT NULL UNIQUE,
  company_id         bigint REFERENCES ${S}.companies(id),
  requested_by       bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  requested_by_name  text,
  department         text,
  party_name         text,
  request_importance text NOT NULL DEFAULT 'normal'
                          CHECK (request_importance IN ('low','normal','high','urgent')),
  payment_mode       text,
  required_time      text,
  expected_inhouse_date date,
  status             text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','submitted','sourced','approved','rejected','po_made','cancelled')),
  proposed_vendor_id bigint REFERENCES ${S}.vendors(id) ON DELETE SET NULL,
  purchaser_id       bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  purchaser_note     text,
  approved_by        bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  approved_at        timestamptz,
  decision_note      text,
  po_reference       text,
  notes              text,
  created_by         bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.requisition_items (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id      bigint NOT NULL REFERENCES ${S}.requisitions(id) ON DELETE CASCADE,
  product_description text NOT NULL,
  quantity            numeric(14,3) NOT NULL DEFAULT 1,
  unit                text,
  size                text,
  purpose             text,
  fixed_rate          numeric(14,2),
  sort_order          int NOT NULL DEFAULT 0
);

-- Vendor quotes gathered by the purchaser for comparison; one is awarded.
CREATE TABLE IF NOT EXISTS ${S}.requisition_quotes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id bigint NOT NULL REFERENCES ${S}.requisitions(id) ON DELETE CASCADE,
  vendor_id      bigint NOT NULL REFERENCES ${S}.vendors(id) ON DELETE CASCADE,
  is_awarded     boolean NOT NULL DEFAULT false,
  total_amount   numeric(14,2) NOT NULL DEFAULT 0,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requisition_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS ${S}.requisition_quote_items (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id            bigint NOT NULL REFERENCES ${S}.requisition_quotes(id) ON DELETE CASCADE,
  requisition_item_id bigint NOT NULL REFERENCES ${S}.requisition_items(id) ON DELETE CASCADE,
  rate                numeric(14,2) NOT NULL DEFAULT 0,
  amount              numeric(14,2) NOT NULL DEFAULT 0,
  UNIQUE (quote_id, requisition_item_id)
);

CREATE TABLE IF NOT EXISTS ${S}.requisition_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id bigint NOT NULL REFERENCES ${S}.requisitions(id) ON DELETE CASCADE,
  action         text NOT NULL,
  note           text,
  user_id        bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${S}_req_status ON ${S}.requisitions(status);
CREATE INDEX IF NOT EXISTS idx_${S}_req_items_req ON ${S}.requisition_items(requisition_id);
CREATE INDEX IF NOT EXISTS idx_${S}_req_quotes_req ON ${S}.requisition_quotes(requisition_id);
CREATE INDEX IF NOT EXISTS idx_${S}_price_list_cat ON ${S}.price_list(category);
CREATE INDEX IF NOT EXISTS idx_${S}_item_master_cat ON ${S}.item_master(category);
CREATE UNIQUE INDEX IF NOT EXISTS uq_${S}_item_master_name ON ${S}.item_master(lower(name));
CREATE INDEX IF NOT EXISTS idx_${S}_sessions_user ON ${S}.sessions(user_id);
`;

async function seed() {
  const companies = await one(`SELECT COUNT(*)::int AS n FROM ${S}.companies`);
  if (companies.n === 0) {
    await run(
      `INSERT INTO ${S}.companies (name, code) VALUES ('Paramount Home Collections Pvt Ltd','PHC')`
    );
  }
  const users = await one(`SELECT COUNT(*)::int AS n FROM ${S}.users`);
  if (users.n === 0) {
    const hash = bcrypt.hashSync(config.seedAdmin.password, 10);
    await run(
      `INSERT INTO ${S}.users (name, email, password_hash, role) VALUES ($1,$2,$3,'admin')`,
      [config.seedAdmin.name, config.seedAdmin.email, hash]
    );
    // eslint-disable-next-line no-console
    console.log(`[seed] Admin account ready: ${config.seedAdmin.email}`);
  }
  await run(`DELETE FROM ${S}.sessions WHERE expires_at < now()`);
}

// Run schema + seed exactly once per process, memoised so concurrent
// serverless requests share a single initialisation.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      // In client mode the schema is provisioned via a Supabase migration, so
      // we skip DDL here. With a direct Postgres connection (local dev), create
      // the schema idempotently.
      if (!useClient) await run(SCHEMA_SQL);
      await seed();
    })().catch((err) => {
      readyPromise = null; // allow a later request to retry
      throw err;
    });
  }
  return readyPromise;
}

module.exports = {
  getPool,
  query,
  one,
  run,
  tx,
  ensureReady,
  S,
  useClient,
  connectionCandidates,
  extractRef,
};
