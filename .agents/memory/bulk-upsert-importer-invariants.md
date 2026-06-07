---
name: Bulk upsert importer invariants
description: Two correctness rules for spreadsheet → DB bulk upsert helpers (party/items master data)
---

When writing a bulk importer that upserts many rows against in-memory match maps
(e.g. `byVat` / `byCode` / `byName` → existing row), two invariants matter:

1. **De-index on key mutation within the batch.** The match maps are built once
   from the existing rows, then mutated as you go. If row N updates a record and
   changes its vat/code/name, the OLD keys still point at the now-stale object.
   A later row N+1 can then match a stale key and update the WRONG record. Fix:
   before re-indexing an updated row, delete its old keys — guarded with an
   identity check (`map.get(k) === oldRow`) so you never evict a key that
   legitimately belongs to a different record.

2. **Ledger creation must be strict on insert.** When a new master record needs
   an auto-created AR/AP sub-account (`ensureCustomerLedger`/`ensureSupplierLedger`),
   do NOT wrap it in try/catch → `accountId = null`. A genuine failure must
   surface as a per-row error (skip the insert) rather than silently inserting a
   party with no ledger, which breaks accounting. A legitimate `null` return (no
   parent account mapped yet) is fine to pass through — that matches the
   single-create route.

**Why:** both were caught in architect review of the customers/suppliers master-
data import; both are silent-corruption bugs that typecheck and tests-by-happy-
path miss.

**How to apply:** any importer in `artifacts/api-server/src/lib/*Import.ts` that
keeps in-memory dedupe maps and/or creates linked sub-accounts.

Drizzle aside: `db.insert(table).values({ ...dynamicRecordAny })` fails TS2769
(the `Record<string, any>` index signature defeats the `.values()` overload) —
cast the literal `as typeof table.$inferInsert`.
