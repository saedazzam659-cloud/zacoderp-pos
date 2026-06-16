---
name: pg pool sizing for the shared multi-tenant pool
description: the single shared pg.Pool default (max=10) is too small for this multi-tenant ERP and causes site-wide slowness/hangs under load.
---

There is exactly ONE `new Pool(...)` in the whole repo (`lib/db/src/index.ts`), shared by every artifact through `@workspace/db`. So pool config is a single global lever — one change fixes (or breaks) everything.

**Rule:** never leave the shared pool on pg defaults. The pg default `max=10` is far too small for a multi-tenant ERP; under concurrent load every request queues for a free client and users perceive it as a site-wide "hang"/slowness, not an error. Size it (default `max=20`, env `PG_POOL_MAX`) and make it env-tunable so prod capacity can change without a code redeploy. Also set `connectionTimeoutMillis` (fail-fast instead of hang-forever when saturated), `idleTimeoutMillis`, `keepAlive`, and a `pool.on("error")` handler so an idle-client error never crashes the process.

**Why:** a single company user reported slowness/hanging in prod; root cause was pool exhaustion, NOT slow queries (logs showed most requests <700ms). The fix is capacity, not query tuning.

**Do NOT set a blanket `statement_timeout` on this pool.** This app runs legitimately long single statements (historical multi-year JE migrations, bulk imports, large financial reports) that a blanket cap kills mid-run. Keep `statement_timeout` opt-in (`PG_STATEMENT_TIMEOUT_MS`, default OFF).

**How to apply:** code defaults only take effect after a deploy/restart. To raise prod capacity immediately, set `PG_POOL_MAX`/`PG_CONNECTION_TIMEOUT_MS`/`PG_IDLE_TIMEOUT_MS` as prod env vars. Budget constraint: `PG_POOL_MAX × api_instance_count` must stay under the DB's max_connections with headroom for admin/migrations.
