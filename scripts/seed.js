'use strict';

/**
 * Optional demo-data seeder. Adds sample suppliers, items, rate lists and
 * purchase orders so the app has something to show. Safe to re-run: it only
 * inserts when there are no suppliers yet.
 *
 *   npm run seed
 */

const { query, one, run, tx, ensureReady, S } = require('../src/db');

(async () => {
  await ensureReady();

  const supplierCount = await one(`SELECT COUNT(*)::int AS n FROM ${S}.suppliers`);
  if (supplierCount.n > 0) {
    console.log('[seed] Suppliers already exist — skipping demo data.');
    process.exit(0);
  }

  const admin = await one(`SELECT id FROM ${S}.users WHERE role = 'admin' ORDER BY id LIMIT 1`);
  const adminId = admin ? admin.id : null;
  const paramount = await one(`SELECT id FROM ${S}.companies WHERE code = 'PARAMOUNT'`);
  const aia = await one(`SELECT id FROM ${S}.companies WHERE code = 'AIA'`);

  await tx(async (c) => {
    const supA = await c.one(
      `INSERT INTO ${S}.suppliers (name, contact_person, email, phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['Al-Karam Textiles', 'Bilal Ahmed', 'sales@alkaram.example', '+92 300 1234567']
    );
    const supB = await c.one(
      `INSERT INTO ${S}.suppliers (name, contact_person, email, phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['Gulberg Ceramics', 'Sana Riaz', 'orders@gulbergceramics.example', '+92 321 7654321']
    );

    const itemDefs = [
      ['Cotton Bath Towel', 'TWL-BATH', 'pcs', 'Linen'],
      ['Cotton Hand Towel', 'TWL-HAND', 'pcs', 'Linen'],
      ['Ceramic Dinner Plate 10in', 'PLT-10', 'pcs', 'Tableware'],
      ['Ceramic Soup Bowl', 'BWL-SOUP', 'pcs', 'Tableware'],
      ['Stainless Steel Spoon', 'SPN-01', 'dozen', 'Cutlery'],
    ];
    const items = [];
    for (const [name, sku, unit, category] of itemDefs) {
      const it = await c.one(
        `INSERT INTO ${S}.items (name, sku, unit, category) VALUES ($1,$2,$3,$4) RETURNING id`,
        [name, sku, unit, category]
      );
      items.push(it.id);
    }

    const rlA = await c.one(
      `INSERT INTO ${S}.rate_lists (title, supplier_id, currency, effective_date, status, created_by)
       VALUES ($1,$2,'PKR',current_date,'active',$3) RETURNING id`,
      ['Al-Karam Textiles — 2026 prices', supA.id, adminId]
    );
    await c.run(`INSERT INTO ${S}.rate_list_items (rate_list_id, item_id, rate, unit) VALUES ($1,$2,850,'pcs'),($1,$3,420,'pcs')`, [rlA.id, items[0], items[1]]);

    const rlB = await c.one(
      `INSERT INTO ${S}.rate_lists (title, supplier_id, currency, effective_date, status, created_by)
       VALUES ($1,$2,'PKR',current_date,'active',$3) RETURNING id`,
      ['Gulberg Ceramics — tableware', supB.id, adminId]
    );
    await c.run(`INSERT INTO ${S}.rate_list_items (rate_list_id, item_id, rate, unit) VALUES ($1,$2,320,'pcs'),($1,$3,260,'pcs'),($1,$4,540,'dozen')`, [rlB.id, items[2], items[3], items[4]]);

    const year = new Date().getFullYear();
    async function createPo(number, companyId, supplierId, status, lines) {
      const subtotal = lines.reduce((s, l) => s + l.qty * l.rate, 0);
      const po = await c.one(
        `INSERT INTO ${S}.purchase_orders (po_number, company_id, supplier_id, status, currency, subtotal, tax_percent, tax_amount, total, created_by)
         VALUES ($1,$2,$3,$4,'PKR',$5,0,0,$5,$6) RETURNING id`,
        [number, companyId, supplierId, status, subtotal, adminId]
      );
      for (const l of lines) {
        await c.run(
          `INSERT INTO ${S}.po_items (po_id, item_id, description, quantity, rate, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [po.id, l.itemId, l.desc, l.qty, l.rate, l.qty * l.rate]
        );
      }
      await c.run(`INSERT INTO ${S}.po_history (po_id, action, note, user_id) VALUES ($1,'created','Demo PO',$2)`, [po.id, adminId]);
      if (status === 'pending') {
        await c.run(`INSERT INTO ${S}.po_history (po_id, action, note, user_id) VALUES ($1,'submitted','Submitted for approval',$2)`, [po.id, adminId]);
      }
    }

    await createPo(`PARAMOUNT-${year}-0001`, paramount.id, supA.id, 'pending', [
      { itemId: items[0], desc: 'Cotton Bath Towel', qty: 100, rate: 850 },
      { itemId: items[1], desc: 'Cotton Hand Towel', qty: 200, rate: 420 },
    ]);
    await createPo(`AIA-${year}-0001`, aia.id, supB.id, 'draft', [
      { itemId: items[2], desc: 'Ceramic Dinner Plate 10in', qty: 150, rate: 320 },
    ]);
  });

  console.log('[seed] Demo data created: 2 suppliers, 5 items, 2 rate lists, 2 purchase orders.');
  process.exit(0);
})().catch((err) => {
  console.error('[seed] Failed:', err.message);
  process.exit(1);
});
