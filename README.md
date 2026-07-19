# Purchase Management System — Paramount Home Collections

A web app that replaces the paper **Purchase Requisition** slip and runs the
whole approval flow up to the point a PO is raised in Tally.

## The workflow

```
Requester              Purchaser                 Owner (final)        Store / Accounts
    │                     │                          │                      │
 raise ──submit──▶  source & compare  ──propose──▶  approve / reject ──▶  make PO in Tally
requisition         vendors (rates)                (go-ahead)            (mark "PO made")
```

1. **Requisition** — any employee fills the digital slip: products, qty, unit,
   size, purpose, department, importance, payment mode, required time, expected
   in-house date. Auto-numbered `PHC-REQ-2026-0001`.
2. **Sourcing** — the **purchaser** enters several vendors' rates side-by-side
   (like a Maya Elec. vs Ambika comparison), totals compute live, and proposes
   one vendor.
3. **Final approval** — the proposal goes to the **owner**, who approves (the
   go-ahead) or rejects.
4. **PO made** — **store/accounts** create the PO in **Tally** (outside this
   system) and mark the requisition "PO made". No Tally integration.

Plus a **Price List** — a master catalogue of prices for everything
(transportation, courier, consumables, non-consumables, freight forwarding,
electrical, …), searchable by category, with CSV upload.

Email notifications are sent at each step (owner CC'd); see *Optional email*.

## Roles

| Role | Can |
| --- | --- |
| **staff** | raise requisitions |
| **purchaser** | source & propose vendors, manage vendors & price list |
| **approver** | give the final approval / rejection |
| **store** | mark PO made, manage vendors & price list |
| **admin** | everything, plus manage users |

## Tech

Node.js + Express (serverless on Vercel) · PostgreSQL (Supabase) · dependency-free
HTML/CSS/JS frontend. All tables live in an isolated `pms` schema.

## Deploying on Vercel + Supabase

The Vercel project auto-deploys from this repo. It connects to the database with
the standard Supabase variables (no DB password needed):

| Vercel env var | Value |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase **service_role** key (Settings → API) |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` *(falls back to the project URL if unset)* |

The app talks to the private `pms` schema through two SECURITY DEFINER RPCs
(`pms_exec_rows` / `pms_exec_run`) that only the service role can call.

Optional variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `admin@paramount.local` / `admin123` | first admin |
| `RESEND_API_KEY` | — | enable email notifications via Resend |
| `NOTIFY_OWNER_EMAIL` | `arbab@paramounthomecollections.com` | CC'd on every notification |
| `DATABASE_URL` | — | direct Postgres string (local dev / override) |

### Optional email

Notifications work without any setup for the **in-app queues** (Dashboard shows
"To source / Awaiting your approval / Ready for PO"). To also send **emails**,
add a `RESEND_API_KEY` (and verify a sending domain in Resend). Until then,
emails are skipped and logged.

## Running locally

```bash
npm install
export DATABASE_URL="postgresql://user:pass@localhost:5432/pms"
npm run seed     # optional demo data
npm start        # http://localhost:3000
```

Default login: `admin@paramount.local` / `admin123` (change it after first login).

## Project layout

```
server.js            Express app (serverless + local)
api/index.js         Vercel entry
src/db.js            Postgres/Supabase transport, schema, seed
src/notify.js        email notifications (Resend, optional)
src/routes/          auth · vendors · price-list · requisitions · users
public/              single-page frontend
```
