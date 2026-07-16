'use strict';

/**
 * Optional demo-data seeder. Adds sample suppliers, items, a rate list and a
 * couple of purchase orders so the app has something to show on first run.
 * Safe to re-run: it only inserts when the tables are empty.
 *
 *   npm run seed
 */

const { db, init } = require('../src/db');

init();

const supplierCount = db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n;
if (supplierCount > 0) {
  console.log('[seed] Suppliers already exist — skipping demo data.');
  process.exit(0);
}

const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
const paramount = db.prepare("SELECT id FROM companies WHERE code = 'PARAMOUNT'").get();
const aia = db.prepare("SELECT id FROM companies WHERE code = 'AIA'").get();

const insertSupplier = db.prepare(
  'INSERT INTO suppliers (name, contact_person, email, phone) VALUES (?, ?, ?, ?)'
);
const alkaram = insertSupplier.run('Al-Karam Textiles', 'Bilal Ahmed', 'sales@alkaram.example', '+92 300 1234567').lastInsertRowid;
const gulberg = insertSupplier.run('Gulberg Ceramics', 'Sana Riaz', 'orders@gulbergceramics.example', '+92 321 7654321').lastInsertRowid;

const insertItem = db.prepare('INSERT INTO items (name, sku, unit, category) VALUES (?, ?, ?, ?)');
const items = [
  ['Cotton Bath Towel', 'TWL-BATH', 'pcs', 'Linen'],
  ['Cotton Hand Towel', 'TWL-HAND', 'pcs', 'Linen'],
  ['Ceramic Dinner Plate 10in', 'PLT-10', 'pcs', 'Tableware'],
  ['Ceramic Soup Bowl', 'BWL-SOUP', 'pcs', 'Tableware'],
  ['Stainless Steel Spoon', 'SPN-01', 'dozen', 'Cutlery'],
].map((row) => insertItem.run(...row).lastInsertRowid);

// Rate list for Al-Karam (towels)
const rlResult = db
  .prepare(
    `INSERT INTO rate_lists (title, supplier_id, company_id, currency, effective_date, status, created_by)
     VALUES (?, ?, ?, 'PKR', date('now'), 'active', ?)`
  )
  .run('Al-Karam Textiles — 2026 prices', alkaram, null, admin ? admin.id : null);
const rlId = rlResult.lastInsertRowid;
const rlItem = db.prepare('INSERT INTO rate_list_items (rate_list_id, item_id, rate, unit) VALUES (?, ?, ?, ?)');
rlItem.run(rlId, items[0], 850, 'pcs');
rlItem.run(rlId, items[1], 420, 'pcs');

// Rate list for Gulberg (tableware)
const rl2 = db
  .prepare(
    `INSERT INTO rate_lists (title, supplier_id, company_id, currency, effective_date, status, created_by)
     VALUES (?, ?, ?, 'PKR', date('now'), 'active', ?)`
  )
  .run('Gulberg Ceramics — tableware', gulberg, null, admin ? admin.id : null).lastInsertRowid;
rlItem.run(rl2, items[2], 320, 'pcs');
rlItem.run(rl2, items[3], 260, 'pcs');
rlItem.run(rl2, items[4], 540, 'dozen');

// A pending PO for Paramount
function createPo(number, companyId, supplierId, status, lines) {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const po = db
    .prepare(
      `INSERT INTO purchase_orders (po_number, company_id, supplier_id, status, currency, subtotal, tax_percent, tax_amount, total, created_by)
       VALUES (?, ?, ?, ?, 'PKR', ?, 0, 0, ?, ?)`
    )
    .run(number, companyId, supplierId, status, subtotal, subtotal, admin ? admin.id : null).lastInsertRowid;
  const li = db.prepare('INSERT INTO po_items (po_id, item_id, description, quantity, rate, amount) VALUES (?, ?, ?, ?, ?, ?)');
  for (const l of lines) li.run(po, l.itemId, l.desc, l.qty, l.rate, l.qty * l.rate);
  db.prepare('INSERT INTO po_history (po_id, action, note, user_id) VALUES (?, ?, ?, ?)').run(po, 'created', 'Demo PO', admin ? admin.id : null);
  if (status === 'pending') db.prepare('INSERT INTO po_history (po_id, action, note, user_id) VALUES (?, ?, ?, ?)').run(po, 'submitted', 'Submitted for approval', admin ? admin.id : null);
  return po;
}

const year = new Date().getFullYear();
createPo(`PARAMOUNT-${year}-0001`, paramount.id, alkaram, 'pending', [
  { itemId: items[0], desc: 'Cotton Bath Towel', qty: 100, rate: 850 },
  { itemId: items[1], desc: 'Cotton Hand Towel', qty: 200, rate: 420 },
]);
createPo(`AIA-${year}-0001`, aia.id, gulberg, 'draft', [
  { itemId: items[2], desc: 'Ceramic Dinner Plate 10in', qty: 150, rate: 320 },
]);

console.log('[seed] Demo data created: 2 suppliers, 5 items, 2 rate lists, 2 purchase orders.');
