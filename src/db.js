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

const isLocal = /localhost|127\.0\.0\.1|::1/.test(config.databaseUrl);

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal || !config.databaseUrl ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX, 10) || 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

const S = config.dbSchema; // schema name, e.g. "pms"

/** Run a query and return the rows. */
async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
/** Run a query and return the first row (or null). */
async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}
/** Run a query and return the raw result (rowCount, etc.). */
async function run(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction. `fn` receives a client-bound helper with the
 * same query/one/run interface so every statement uses the same connection.
 */
async function tx(fn) {
  const client = await pool.connect();
  const helper = {
    query: async (t, p) => (await client.query(t, p)).rows,
    one: async (t, p) => (await client.query(t, p)).rows[0] || null,
    run: (t, p) => client.query(t, p),
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
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','approver','staff')),
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

CREATE TABLE IF NOT EXISTS ${S}.suppliers (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,
  contact_person text, email text, phone text, address text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  sku        text,
  unit       text NOT NULL DEFAULT 'pcs',
  category   text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.rate_lists (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title          text NOT NULL,
  supplier_id    bigint NOT NULL REFERENCES ${S}.suppliers(id) ON DELETE CASCADE,
  company_id     bigint REFERENCES ${S}.companies(id) ON DELETE SET NULL,
  currency       text NOT NULL DEFAULT 'PKR',
  effective_date date,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  notes          text,
  created_by     bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.rate_list_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_list_id bigint NOT NULL REFERENCES ${S}.rate_lists(id) ON DELETE CASCADE,
  item_id      bigint NOT NULL REFERENCES ${S}.items(id) ON DELETE CASCADE,
  rate         numeric(14,2) NOT NULL DEFAULT 0,
  unit         text,
  UNIQUE (rate_list_id, item_id)
);

CREATE TABLE IF NOT EXISTS ${S}.purchase_orders (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_number     text NOT NULL UNIQUE,
  company_id    bigint NOT NULL REFERENCES ${S}.companies(id),
  supplier_id   bigint NOT NULL REFERENCES ${S}.suppliers(id),
  rate_list_id  bigint REFERENCES ${S}.rate_lists(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','cancelled')),
  currency      text NOT NULL DEFAULT 'PKR',
  subtotal      numeric(14,2) NOT NULL DEFAULT 0,
  tax_percent   numeric(6,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL DEFAULT 0,
  expected_date date,
  notes         text,
  created_by    bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  approved_by   bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${S}.po_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id       bigint NOT NULL REFERENCES ${S}.purchase_orders(id) ON DELETE CASCADE,
  item_id     bigint REFERENCES ${S}.items(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity    numeric(14,3) NOT NULL DEFAULT 1,
  rate        numeric(14,2) NOT NULL DEFAULT 0,
  amount      numeric(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ${S}.po_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id      bigint NOT NULL REFERENCES ${S}.purchase_orders(id) ON DELETE CASCADE,
  action     text NOT NULL,
  note       text,
  user_id    bigint REFERENCES ${S}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_${S}_rate_lists_supplier ON ${S}.rate_lists(supplier_id);
CREATE INDEX IF NOT EXISTS idx_${S}_rate_list_items_list ON ${S}.rate_list_items(rate_list_id);
CREATE INDEX IF NOT EXISTS idx_${S}_po_company ON ${S}.purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_${S}_po_status ON ${S}.purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_${S}_po_items_po ON ${S}.po_items(po_id);
CREATE INDEX IF NOT EXISTS idx_${S}_sessions_user ON ${S}.sessions(user_id);
`;

async function seed() {
  const companies = await one(`SELECT COUNT(*)::int AS n FROM ${S}.companies`);
  if (companies.n === 0) {
    await run(`INSERT INTO ${S}.companies (name, code) VALUES ('Paramount','PARAMOUNT'), ('AiA','AIA')`);
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
      await run(SCHEMA_SQL);
      await seed();
    })().catch((err) => {
      readyPromise = null; // allow a later request to retry
      throw err;
    });
  }
  return readyPromise;
}

module.exports = { pool, query, one, run, tx, ensureReady, S };
