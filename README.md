# Purchase Management System

A self-contained web app for **Paramount** and **AiA** to manage supplier
**rate lists** and route every new purchase through a **Purchase Order (PO)
approval workflow**.

It answers the three things asked for:

1. **Fill in a rate list of all items** you send to a supplier — enter them one
   by one, or **upload the whole list** from a spreadsheet (CSV).
2. **A link to upload all rate lists** — the *Rate Lists → Upload* page accepts a
   CSV and creates the items and prices automatically.
3. **Every new purchase is approved by PO** — POs are raised for either
   **Paramount** or **AiA**, submitted for approval, and an approver marks them
   **Approved** or **Rejected**. Nothing is "purchased" until a PO is approved.

---

## Quick start

```bash
npm install        # install dependencies
npm run seed       # (optional) load demo suppliers, items, rate lists & POs
npm start          # start the server
```

Then open **http://localhost:3000**.

Sign in with the default admin account (created automatically on first run):

| Email | Password |
| --- | --- |
| `admin@paramount.local` | `admin123` |

> Change these before real use — see **Configuration** below. From
> *Users*, create staff and approver accounts and change the admin password.

---

## How it works

### Roles

| Role | Can do |
| --- | --- |
| **Staff** | Create suppliers, items, rate lists and purchase orders; submit POs for approval. |
| **Approver** | Everything staff can, **plus** approve / reject pending POs. |
| **Admin** | Everything, **plus** manage users. |

An approver cannot approve a PO they created themselves (unless they are an
admin) — enforcing separation of duties.

### The rate list

A **rate list** is the set of agreed prices for one supplier. Create it two ways:

- **Manually** — *Rate Lists → New rate list*, then add each item + rate.
- **Upload** — *Rate Lists → Upload rate list*. Provide a CSV with these
  columns (header names are flexible — `price`, `item`, `unit_price`, etc. also
  work):

  ```csv
  item_name,sku,unit,category,rate
  Cotton Bath Towel,TWL-BATH,pcs,Linen,850
  Ceramic Dinner Plate 10in,PLT-10,pcs,Tableware,320
  ```

  A ready-to-use sample is in [`sample-rate-list.csv`](./sample-rate-list.csv),
  and a template can be downloaded from the upload page. Using Excel? Save the
  sheet as CSV first (*File → Save As → CSV*).

### The purchase order workflow

```
draft ──submit──▶ pending ──approve──▶ approved
                     │
                     └────reject─────▶ rejected
```

1. Staff raise a PO, choosing **Paramount** or **AiA** and a supplier.
2. Line items can be pulled straight from the supplier's rate list
   (*Load supplier rates*) or typed in; totals and tax are calculated live.
3. Save as a **draft**, or **submit for approval**.
4. An **approver** opens the pending PO and **approves** or **rejects** it (with
   an optional note). Every step is recorded in the PO's history/audit trail.

PO numbers are generated per company and year, e.g. `PARAMOUNT-2026-0001`,
`AIA-2026-0001`.

---

## Configuration

Configuration is via environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `./data/pms.db` | SQLite database file |
| `SEED_ADMIN_EMAIL` | `admin@paramount.local` | First admin's email |
| `SEED_ADMIN_PASSWORD` | `admin123` | First admin's password |
| `SESSION_TTL_MS` | `604800000` (7 days) | Login session lifetime |

Example:

```bash
SEED_ADMIN_EMAIL=owner@paramount.com SEED_ADMIN_PASSWORD='a-strong-secret' npm start
```

---

## Tech stack

- **Backend:** Node.js + Express, SQLite (via `better-sqlite3`)
- **Auth:** cookie-based sessions, bcrypt password hashing
- **Uploads:** `multer` + `csv-parse`
- **Frontend:** dependency-free HTML/CSS/JavaScript single-page app

No external accounts or services are required — the whole system runs from a
single SQLite file, so it is easy to back up (copy `data/pms.db`) and to deploy
later to any Node host.

## Project layout

```
server.js              app entry point
src/
  config.js            environment configuration
  db.js                schema + seed (companies, admin)
  auth.js              sessions, password hashing, guards
  routes/              REST API (auth, suppliers, items, rate lists, POs, users)
public/                single-page frontend (HTML/CSS/JS)
scripts/seed.js        optional demo data
sample-rate-list.csv   example upload file
```

## Data & backups

All data lives in `data/pms.db`. Back it up by copying that file. Deleting it
resets the system (a fresh admin account is recreated on next start).
