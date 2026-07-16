'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

// Ensure the data directory exists before opening the database.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Create the schema. Each statement is idempotent (IF NOT EXISTS) so the
 * function can safely run on every start-up.
 */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'staff'
                            CHECK (role IN ('admin', 'approver', 'staff')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- The two purchasing entities: Paramount and AiA.
    CREATE TABLE IF NOT EXISTS companies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      code       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      contact_person TEXT,
      email          TEXT,
      phone          TEXT,
      address        TEXT,
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      sku        TEXT,
      unit       TEXT NOT NULL DEFAULT 'pcs',
      category   TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A rate list is a set of agreed item prices for a given supplier.
    -- company_id NULL means the list applies to all companies.
    CREATE TABLE IF NOT EXISTS rate_lists (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT NOT NULL,
      supplier_id    INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      currency       TEXT NOT NULL DEFAULT 'PKR',
      effective_date TEXT,
      status         TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('draft', 'active', 'archived')),
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_list_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_list_id INTEGER NOT NULL REFERENCES rate_lists(id) ON DELETE CASCADE,
      item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      rate         REAL NOT NULL DEFAULT 0,
      unit         TEXT,
      UNIQUE (rate_list_id, item_id)
    );

    -- Purchase orders. Every purchase belongs to a company (Paramount / AiA)
    -- and must move through the approval workflow before it is acted on.
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number     TEXT NOT NULL UNIQUE,
      company_id    INTEGER NOT NULL REFERENCES companies(id),
      supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
      rate_list_id  INTEGER REFERENCES rate_lists(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
      currency      TEXT NOT NULL DEFAULT 'PKR',
      subtotal      REAL NOT NULL DEFAULT 0,
      tax_percent   REAL NOT NULL DEFAULT 0,
      tax_amount    REAL NOT NULL DEFAULT 0,
      total         REAL NOT NULL DEFAULT 0,
      expected_date TEXT,
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at   TEXT,
      decision_note TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS po_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id       INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id     INTEGER REFERENCES items(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      quantity    REAL NOT NULL DEFAULT 1,
      rate        REAL NOT NULL DEFAULT 0,
      amount      REAL NOT NULL DEFAULT 0
    );

    -- Immutable audit trail of significant PO events.
    CREATE TABLE IF NOT EXISTS po_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id      INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      action     TEXT NOT NULL,
      note       TEXT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rate_lists_supplier ON rate_lists(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_rate_list_items_list ON rate_list_items(rate_list_id);
    CREATE INDEX IF NOT EXISTS idx_po_company ON purchase_orders(company_id);
    CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
}

/**
 * Insert the baseline reference data required for the app to be usable:
 * the two companies and an initial admin account.
 */
function seed() {
  const companyCount = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
  if (companyCount === 0) {
    const insert = db.prepare('INSERT INTO companies (name, code) VALUES (?, ?)');
    insert.run('Paramount', 'PARAMOUNT');
    insert.run('AiA', 'AIA');
  }

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const hash = bcrypt.hashSync(config.seedAdmin.password, 10);
    db.prepare(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(config.seedAdmin.name, config.seedAdmin.email, hash, 'admin');
    // eslint-disable-next-line no-console
    console.log(
      `[seed] Created admin account: ${config.seedAdmin.email} / ${config.seedAdmin.password}`
    );
  }
}

/** Remove expired session rows. Called lazily on start-up. */
function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function init() {
  migrate();
  seed();
  pruneSessions();
}

module.exports = { db, init, migrate, seed, pruneSessions };
