---
name: ext_records missing-table warning is a false alarm
description: Why boot logs flag ext_records (and other ext_* / runtime tables) as missing even though they get created
---

The api-server boot log emits `ensureSchema: schema declares tables that don't exist in DB ... missingTables: ["ext_records", ...]`.

**This is a false alarm for the extension-platform runtime tables.** The Drizzle schema *reconciliation* pass runs FIRST and only WARNS about declared-but-absent tables; it never creates them. A SEPARATE custom-DDL step list later in `src/lib/ensureSchema.ts` actually creates `ext_records` (+ its indexes) with `CREATE TABLE IF NOT EXISTS`. So the table really does exist after boot — verify with `psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.ext_records')"` before chasing it.

**Why:** the two mechanisms (drizzle reconciliation vs. hand-written DDL steps) don't know about each other and run check-then-create, so anything created by the DDL-step path is reported missing by the earlier reconciliation pass.

**How to apply:** don't "fix" a missing ext_* / runtime table by adding it to the drizzle reconciler or running db:push — confirm via psql first; it's almost certainly already created by the ensureSchema DDL-step block.
