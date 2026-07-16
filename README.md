# Purchase Management System

A web app for **Paramount** and **AiA** to manage supplier **rate lists** and
route every purchase through a **Purchase Order (PO) approval workflow**.

It does the three things asked for:

1. **Fill in a rate list of all items** you send to a supplier — enter them one
   by one, or **upload the whole list** from a spreadsheet (CSV).
2. **A link to upload all rate lists** — *Rate Lists → Upload* accepts a CSV and
   creates the items and prices automatically.
3. **Every new purchase is approved by a PO** — POs are raised for **Paramount**
   or **AiA**, submitted for approval, and an approver marks them **Approved** or
   **Rejected**. Nothing is purchased until a PO is approved.

**Stack:** Node.js + Express (serverless on Vercel), PostgreSQL (Supabase),
dependency-free HTML/CSS/JS frontend. All tables live in an isolated `pms`
schema so they never collide with anything else in the database.

---

## Deploying on Vercel + Supabase

The app is wired to deploy automatically: pushing to the repository triggers a
Vercel build. It needs **one** environment variable to connect to the database.

### 1. Add the database connection string in Vercel

In the Vercel project **Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Your Supabase **Transaction pooler** connection string |

Get it from Supabase: **Project → Connect → Transaction pooler** (port `6543`),
which looks like:

```
postgresql://postgres.<project-ref>:<YOUR-DB-PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Optional variables (sensible defaults are used if omitted):

| Name | Default | Purpose |
| --- | --- | --- |
| `SEED_ADMIN_EMAIL` | `admin@paramount.local` | First admin account's email |
| `SEED_ADMIN_PASSWORD` | `admin123` | First admin account's password |
| `DB_SCHEMA` | `pms` | Postgres schema the app uses |
| `SESSION_TTL_MS` | `604800000` | Login session lifetime (7 days) |

### 2. Redeploy

Trigger a redeploy (or push a commit). On the first request the app creates its
schema (if missing) and the initial admin account, then you can sign in.

> The database schema is also kept as a Supabase migration (`pms_init_schema`),
> so the tables exist independently of the app's first-run bootstrap.

---

## Running locally

Requires a PostgreSQL database. Point `DATABASE_URL` at it:

```bash
npm install
export DATABASE_URL="postgresql://user:pass@localhost:5432/pms"
npm run seed     # optional: demo suppliers, items, rate lists & POs
npm start        # → http://localhost:3000
```

Default admin (change it via env vars): **`admin@paramount.local`** / **`admin123`**.

---

## How it works

### Roles

| Role | Can do |
| --- | --- |
| **Staff** | Create suppliers, items, rate lists and POs; submit POs for approval. |
| **Approver** | Everything staff can, **plus** approve / reject pending POs. |
| **Admin** | Everything, **plus** manage users. |

An approver cannot approve a PO they created themselves (unless they are an
admin) — enforcing separation of duties.

### The rate list

A **rate list** is the set of agreed prices for one supplier. Create it two ways:

- **Manually** — *Rate Lists → New rate list*, then add each item + rate.
- **Upload** — *Rate Lists → Upload rate list*, with a CSV whose columns are
  flexible (`item_name`/`item`, `sku`, `unit`, `category`, `rate`/`price`):

  ```csv
  item_name,sku,unit,category,rate
  Cotton Bath Towel,TWL-BATH,pcs,Linen,850
  Ceramic Dinner Plate 10in,PLT-10,pcs,Tableware,320
  ```

  A sample is in [`sample-rate-list.csv`](./sample-rate-list.csv); a template can
  be downloaded from the upload page. Using Excel? Save as CSV first.

### The purchase-order workflow

```
draft ──submit──▶ pending ──approve──▶ approved
                     │
                     └────reject─────▶ rejected
```

Staff raise a PO (choosing Paramount or AiA and a supplier), pull line items
from the supplier's rate list or type them in, then submit. An approver approves
or rejects it. Every step is recorded in the PO's history. PO numbers are per
company and year, e.g. `PARAMOUNT-2026-0001`.

---

## Project layout

```
server.js              Express app (exported for serverless + local listen)
api/index.js           Vercel serverless entry
vercel.json            Vercel routing (static assets + API function)
src/
  config.js            environment configuration
  db.js                Postgres pool, schema bootstrap, seed
  auth.js              sessions, password hashing, guards
  routes/              REST API (auth, suppliers, items, rate lists, POs, users)
public/                single-page frontend (HTML/CSS/JS)
scripts/seed.js        optional demo data
sample-rate-list.csv   example upload file
```
