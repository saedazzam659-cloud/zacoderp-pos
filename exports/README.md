# Zacod ERP — Saudi ZATCA E-Invoicing Platform

A multi-tenant, Arabic-first (RTL) ERP & point-of-sale platform compliant with the
Saudi **ZATCA** e-invoicing specification. Built as a **pnpm monorepo** with three
web artifacts and a shared Express API.

---

## 📦 What's in this export

```
exports/
├── README.md                ← this file (setup guide)
├── .env.example             ← required environment variables
├── database_schema.sql      ← schema only (CREATE TABLE …), ~160 tables
├── database_full.sql        ← schema + all rows (pg_dump, --clean --if-exists)
└── ERD.md                   ← entity-relationship overview
```

The full source tree is packaged alongside this folder (see the sibling archive
`zacoderp-source.tar.gz`).

---

## 🏗️ Project structure

```
zacoderp/
├── artifacts/                         # four deployable apps in one monorepo
│   ├── api-server/                    # Express + Drizzle backend (port 8080)
│   │   └── src/
│   │       ├── index.ts               # server entry point
│   │       ├── routes/                # grouped REST routers (40+ files)
│   │       ├── lib/                   # helpers (logger, objectStorage, auth)
│   │       └── jobs/                  # scheduled tasks (auto-backup, …)
│   ├── zatca-invoicing/               # main ERP web app (React + Vite, RTL)
│   │   └── src/
│   │       ├── pages/                 # one folder per module
│   │       │   ├── sales/             # invoices, quotations, returns
│   │       │   ├── purchasing/        # purchase orders, invoices, LC
│   │       │   ├── inventory/         # items, warehouses, stock-moves
│   │       │   ├── accounting/        # chart of accounts, journal entries
│   │       │   ├── hr/                # employees, payroll
│   │       │   ├── settings/          # POS mapping, currencies, users
│   │       │   └── reports/           # VAT declaration, P&L, balance sheet
│   │       ├── components/            # shared UI + data-grid
│   │       ├── config/                # accountingMappings, nav config
│   │       ├── hooks/                 # auth, printing, i18n
│   │       ├── locales/               # ar / en translation JSON
│   │       └── lib/api.ts             # typed fetch client for the backend
│   ├── pos/                           # cashier front-end (React + Vite)
│   │   └── src/pages/
│   │       ├── Cashier.tsx            # classic tile POS
│   │       └── Supermarket.tsx        # line-based POS with AI suggestions
│   └── mockup-sandbox/                # internal UI component preview
├── lib/
│   └── db/                            # shared Drizzle ORM layer
│       └── src/
│           ├── index.ts               # db connection (postgres-js)
│           ├── drizzle.config.ts
│           └── schema/                # one file per business domain
│               ├── companies.ts       sales.ts       purchasing.ts
│               ├── accounts.ts        inventory.ts   invoices.ts
│               ├── pos.ts             customers.ts   suppliers.ts
│               ├── hr.ts              cash.ts        currencies.ts
│               ├── journalEntries.ts  fiscalPeriods.ts
│               ├── accountingMappings.ts costCenters.ts branches.ts
│               ├── notifications.ts   plans.ts       supportMessages.ts
│               ├── autoBackups.ts     users.ts       index.ts (re-export)
├── scripts/                           # post-merge + utility scripts
├── pnpm-workspace.yaml                # workspace definition
├── package.json                       # root (typecheck, build)
└── tsconfig.base.json
```

---

## 🔧 Prerequisites

| Tool           | Version | Notes                                                    |
| -------------- | ------- | -------------------------------------------------------- |
| **Node.js**    | ≥ 20.x  | Uses native `fetch`, ESM                                 |
| **pnpm**       | ≥ 9.x   | `npm i -g pnpm`                                          |
| **PostgreSQL** | ≥ 14    | Local install or Docker (`docker run postgres:16`)       |
| **Git**        | any     | To clone the repo                                        |

> ⚠️ This project uses **pnpm workspaces with TypeScript project references**.
> Do not use `npm` or `yarn` — the preinstall hook will abort.

---

## 🚀 Getting started (local)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

```bash
cp exports/.env.example .env
# then edit .env and set at least DATABASE_URL and SESSION_SECRET
```

See `.env.example` in this folder for every supported variable.

### 3. Create the database

Either **restore the included dump** (keeps existing data, admin user, seed
chart of accounts, etc.)…

```bash
createdb zacoderp
psql "$DATABASE_URL" < exports/database_full.sql
```

…or start **empty** and let Drizzle create the tables from the TypeScript
schema:

```bash
createdb zacoderp
pnpm --filter @workspace/db run db:push --force
```

Both approaches produce the same schema.

### 4. Start everything

Open four terminals (or a process manager) and run:

```bash
# Terminal 1 — backend API
pnpm --filter @workspace/api-server run dev        # → http://localhost:8080

# Terminal 2 — main ERP web app
pnpm --filter @workspace/zatca-invoicing run dev   # → http://localhost:<auto>/

# Terminal 3 — POS front-end
pnpm --filter @workspace/pos run dev               # → http://localhost:<auto>/pos/

# Terminal 4 — component sandbox (optional)
pnpm --filter @workspace/mockup-sandbox run dev
```

> Each Vite server reads `PORT` from the environment. In development, Vite
> picks a free port automatically and prints it. In production, your process
> manager (systemd, PM2, Fly/Render/Railway, …) must pass `PORT` to each
> artifact.

### 5. Log in

If you restored `database_full.sql` there's a pre-seeded admin account.
Ask the project owner for credentials (they're not checked into the repo).

Otherwise create the first super-admin via the `/api/auth/register` endpoint
described in the API section below.

---

## 🧱 Build for production

```bash
# Typecheck everything
pnpm run typecheck

# Build every artifact (api-server + three web apps)
pnpm run build
```

Each artifact emits a production bundle under `artifacts/<name>/dist/`.

The API server is a plain Node.js process — run it with:

```bash
node artifacts/api-server/dist/index.js
```

The web apps are static files — serve `dist/` with any static host
(Nginx, CloudFront, Cloudflare Pages, Replit Static, …). They call the API
through relative paths, so host them behind the same reverse proxy as the API
(or configure CORS via the `FRONTEND_ORIGIN` env var).

---

## 🔌 How the frontends talk to the backend

Every web app uses a thin typed wrapper in `src/lib/api.ts`. All requests go to
the same origin; the backend is mounted under `/api/*`. A reverse proxy
(Nginx, Replit's path-based router, Vite's `server.proxy`) routes:

```
GET  /api/*           → api-server on port 8080
GET  /                → zatca-invoicing (ERP)
GET  /pos/*           → pos artifact
```

### Main REST groups (backend routes)

| Prefix                          | Purpose                                     |
| ------------------------------- | ------------------------------------------- |
| `/api/auth/*`                   | Login, logout, session refresh              |
| `/api/org/*`                    | Companies, branches, users                  |
| `/api/inventory/*`              | Items, item-groups, units, warehouses       |
| `/api/sales/*`                  | Invoices, returns, quotations, customers    |
| `/api/purchasing/*`             | PO, purchase invoices, suppliers, LC        |
| `/api/accounting/*`             | Chart of accounts, journal entries          |
| `/api/accounting-mappings/*`    | Document-type → account role mapping        |
| `/api/cash/*`                   | Cashboxes, bank accounts, transfers         |
| `/api/hr/*`                     | Employees, payroll                          |
| `/api/pos-sessions/*`           | Cashier sessions                            |
| `/api/pos-terminals/*`          | Terminal configuration                      |
| `/api/zatca/*`                  | Compliance CSR, certificate, XML signing    |
| `/api/reports/*`                | VAT declaration, P&L, balance sheet         |
| `/api/backup/*`                 | Manual + scheduled DB backups (object store)|

Authentication is **session-based** (cookie) — the cookie is signed with
`SESSION_SECRET`. The POS also reads a mirror token from `localStorage` for
offline resilience.

---

## 🗄️ Database

* **Engine:** PostgreSQL 14+
* **ORM:** [Drizzle ORM](https://orm.drizzle.team) (schemas in `lib/db/src/schema/`)
* **~160 tables** across sales, purchasing, accounting, HR, POS, ZATCA meta,
  audit log, sessions, auto-backups.
* See `database_schema.sql` for the full DDL and `ERD.md` for a summary of the
  main entities and foreign-key relationships.

### Multi-tenancy

Every business table carries a `companyId` (FK → `companies.id`). The API
middleware guards every query with the caller's companyId derived from the
session, so tenants are isolated at the request level.

### Re-generating the schema from the Drizzle definitions

```bash
pnpm --filter @workspace/db run db:push --force
```

This compares the TypeScript schema to the live DB and emits non-destructive
`ALTER TABLE` statements. **Never hand-write migrations** — treat the Drizzle
files as the source of truth.

---

## ☁️ Deployment

The project is deployment-agnostic. Any host that can run Node.js + Postgres
works:

### Option A — Replit (current)

Click **Publish** in the workspace. Replit handles TLS, process management,
scaling, and routes the path-based artifacts automatically. The production
URL is `<your-slug>.replit.app`.

### Option B — Render / Railway / Fly.io

1. Provision a Postgres instance and copy its URL into `DATABASE_URL`.
2. Create 4 services (or one with a process manager). For each:
   * **Build command:** `pnpm install && pnpm -r --filter ./artifacts/<name> run build`
   * **Start command:** see the per-artifact section above.
3. Map a subdomain or path prefix per artifact in the platform's router.

### Option C — VPS (DigitalOcean, Hetzner, self-host)

1. Install Node 20, pnpm, PostgreSQL 16, Nginx.
2. `git clone`, `pnpm install`, set `.env`, `pnpm run build`.
3. Run each artifact under `pm2` or a systemd unit.
4. Nginx config (simplified):

    ```nginx
    server {
      server_name erp.example.com;
      location /api/ { proxy_pass http://127.0.0.1:8080; }
      location /pos/ { proxy_pass http://127.0.0.1:5174; }
      location /     { proxy_pass http://127.0.0.1:5173; }
    }
    ```

5. Point DNS to the server, add TLS with `certbot --nginx`.

### Production checklist

* [ ] `NODE_ENV=production`
* [ ] Long random `SESSION_SECRET` (≥ 48 chars)
* [ ] `DATABASE_URL` uses SSL (`?sslmode=require`)
* [ ] Object storage bucket created and the three `*_OBJECT_*` env vars set
      (attachments, item images, auto-backups)
* [ ] Scheduled job enabled for `/api/backup/auto-run` (cron or platform timer)
* [ ] ZATCA compliance CSR generated + production certificate installed
      (Settings → ZATCA in the ERP)
* [ ] At least one super-admin user created and credentials stored securely

---

## 🆘 Troubleshooting

| Symptom                                            | Fix                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `preinstall` aborts with "Use pnpm instead"        | Use `pnpm install`, not `npm` or `yarn`.                                            |
| Vite server shows blank preview                    | Make sure each artifact reads `PORT` from env; don't hardcode in `vite.config.ts`.  |
| API returns 401 for all routes                     | `SESSION_SECRET` missing or changed — clear cookies and re-log-in.                  |
| `db:push` asks to drop columns                     | Re-run with `--force`. Never accept if you care about the data.                     |
| ZATCA submission fails                             | Check the Compliance tab — usually the CSR isn't signed or the cert has expired.    |
| Accounting Mappings buttons disabled               | Run `POST /api/accounting-mappings/seed-lc` to seed standard CoA accounts.          |

---

## 📜 License

Proprietary — © 2025-2026. All rights reserved.
Distribute the source only to teams authorised by the project owner.
