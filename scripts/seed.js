'use strict';

/**
 * Optional demo-data seeder for the requisition system. Adds a few vendors,
 * price-list entries and one requisition. Safe to re-run: only inserts when
 * there are no requisitions yet.
 *
 *   npm run seed
 */

const { one, tx, ensureReady, S } = require('../src/db');

(async () => {
  await ensureReady();

  const existing = await one(`SELECT COUNT(*)::int AS n FROM ${S}.requisitions`);
  if (existing.n > 0) {
    console.log('[seed] Requisitions already exist — skipping demo data.');
    process.exit(0);
  }
  const admin = await one(`SELECT id FROM ${S}.users WHERE role='admin' ORDER BY id LIMIT 1`);
  const adminId = admin ? admin.id : null;

  await tx(async (c) => {
    const maya = await c.one(`INSERT INTO ${S}.vendors (name, phone) VALUES ('Maya Elec.', '+91 90000 00001') RETURNING id`);
    const ambika = await c.one(`INSERT INTO ${S}.vendors (name, phone) VALUES ('Ambika Traders', '+91 90000 00002') RETURNING id`);

    const prices = [
      ['Transportation', 'Truck 20ft (local)', 'trip', 3500],
      ['Courier', 'Domestic courier up to 5kg', 'shipment', 250],
      ['Consumables', 'A4 Paper Ream', 'ream', 320],
      ['Freight Forwarding', 'Sea freight per CBM', 'cbm', 1800],
      ['Electrical', 'MCB Box 4 way', 'pc', 220],
      ['Electrical', 'Wire 2.5mm poly cab', 'coil', 4625],
    ];
    for (const [cat, name, unit, price] of prices) {
      await c.run(
        `INSERT INTO ${S}.price_list (category, item_name, unit, price, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [cat, name, unit, price, adminId]
      );
    }

    const year = new Date().getFullYear();
    const req = await c.one(
      `INSERT INTO ${S}.requisitions
         (req_number, requested_by, requested_by_name, department, request_importance, status, created_by)
       VALUES ($1,$2,'System Admin','Electric','high','submitted',$2) RETURNING id`,
      [`PHC-REQ-${year}-0001`, adminId]
    );
    await c.run(
      `INSERT INTO ${S}.requisition_items (requisition_id, product_description, quantity, unit, purpose, sort_order)
       VALUES ($1,'MCB Box 4way',10,'pc','wood stock hall',0), ($1,'Wire 2.5mm',500,'mtr','factory use',1)`,
      [req.id]
    );
    await c.run(`INSERT INTO ${S}.requisition_history (requisition_id, action, note, user_id) VALUES ($1,'created','Demo requisition',$2),($1,'submitted','Submitted for sourcing',$2)`, [req.id, adminId]);
  });

  console.log('[seed] Demo data created: 2 vendors, 6 prices, 1 requisition.');
  process.exit(0);
})().catch((err) => {
  console.error('[seed] Failed:', err.message);
  process.exit(1);
});
