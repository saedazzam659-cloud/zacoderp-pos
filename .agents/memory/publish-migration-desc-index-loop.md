---
name: Publish migration loop from DESC index in startup DDL
description: Why a deployment hangs forever at "Validating database migrations" on a DROP/CREATE INDEX, and the root cause (DESC ordering + startup-time DDL).
---

# Publish hangs at "Validating database migrations" — DESC index loop

**Symptom:** Replit Publish gets stuck at "Validating database migrations…",
showing a generated `DROP INDEX … ; CREATE INDEX … ;` for the SAME index that
reappears on every republish and never converges.

**Root cause (two compounding problems):**
1. **Startup-time DDL** in `artifacts/api-server/src/lib/ensureSchema.ts` runs
   `CREATE INDEX IF NOT EXISTS … (col, ts DESC)` on every boot — an explicitly
   forbidden anti-pattern (see database skill `database-migrations-on-publish.md`).
2. **`DESC` in the index column list does not round-trip** through Replit's
   publish diff. The publish flow introspects dev DB ↔ prod DB and drizzle-kit's
   generated SQL drops the `DESC` modifier — so it writes an **ASC** index to prod,
   but dev still has the **DESC** index. Next diff: dev(DESC) ≠ prod(ASC) → it
   regenerates the identical migration forever. The "validating" step never
   converges.

**Fix:** make all four sources agree on a plain **ASC** column list (no `DESC`):
the Drizzle schema (`lib/db/src/schema/*`), the `ensureSchema` startup SQL, the
dev database, and (via the next publish) prod. A plain btree on `(col, ts)` serves
`ORDER BY ts DESC` queries equally well — Postgres scans the index backward — so
dropping `DESC` has zero query-performance cost. Recreate the dev index by hand
(`DROP INDEX … ; CREATE INDEX … (col, ts);` against `DATABASE_URL`) so dev matches
prod, then the user re-publishes and the diff is empty.

**Why:** confirmed by reading prod (read-only `executeSql environment:production`,
`pg_indexes`) = ASC while dev = DESC for `integration_sync_runs_connection_idx`.

**How to apply / prevent:**
- Never put `DESC` (or `.desc()`) inside an index column list that must survive
  the publish diff. Keep index defs plain ASC.
- Never rely on startup-time `CREATE INDEX/TABLE` to manage the prod schema; it
  fights the publish flow. (This app has a large legacy `ensureSchema` doing this.)
- The agent CANNOT fix prod directly — production `executeSql` is read-only and
  direct prod DDL is forbidden. The only fix path is: align schema+dev, then the
  USER re-publishes (publishing is user-initiated). A stuck publish must be
  cancelled in the Publish UI first.
- Latent landmines in this repo: `ensureSchema` still has `DESC` on
  `store_orders_status_idx` and (historically) `chat_conv_company_idx`. They are
  currently consistent dev↔prod so they don't loop — but the moment one side
  flips to ASC they will. Harden them to ASC if they ever start drifting.
