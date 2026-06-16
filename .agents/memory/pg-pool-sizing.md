---
name: pg pool sizing for the shared multi-tenant pool
description: the single shared pg.Pool default (max=10) is too small for this multi-tenant ERP and causes site-wide slowness/hangs under load.
---

There is exactly ONE `new Pool(...)` in the whole repo (`lib/db/src/index.ts`), shared by every artifact through `@workspace/db`. So pool config is a single global lever — one change fixes (or breaks) everything.

**Rule:** never leave the shared pool on pg defaults. The pg default `max=10` is far too small for a multi-tenant ERP; under concurrent load every request queues for a free client and users perceive it as a site-wide "hang"/slowness, not an error. Size it (default `max=20`, env `PG_POOL_MAX`) and make it env-tunable so prod capacity can change without a code redeploy. Also set `connectionTimeoutMillis` (fail-fast instead of hang-forever when saturated), `idleTimeoutMillis`, `keepAlive`, and a `pool.on("error")` handler so an idle-client error never crashes the process.

**Why:** a single company user reported slowness/hanging in prod; root cause was pool exhaustion, NOT slow queries (logs showed most requests <700ms). The fix is capacity, not query tuning.

**Do NOT set a blanket `statement_timeout` on this pool.** This app runs legitimately long single statements (historical multi-year JE migrations, bulk imports, large financial reports) that a blanket cap kills mid-run. Keep `statement_timeout` opt-in (`PG_STATEMENT_TIMEOUT_MS`, default OFF).

**How to apply:** code defaults only take effect after a deploy/restart. To raise prod capacity immediately, set `PG_POOL_MAX`/`PG_CONNECTION_TIMEOUT_MS`/`PG_IDLE_TIMEOUT_MS` as prod env vars. Budget constraint: `PG_POOL_MAX × api_instance_count` must stay under the DB's max_connections with headroom for admin/migrations.

**Saturation monitor (the early-warning lever):** the pool exhaustion signal is `pool.waitingCount > 0` (clients queued for a free client) — NOT `totalCount`. The monitor in this file logs a warning ONLY when `waitingCount > 0`, so it is silent/zero-noise under healthy load. It MUST be `.unref()`'d (a plain `setInterval` keeps the process alive and blocks graceful shutdown). Gated by `PG_POOL_LOG` (off when `0`/`false`), cadence `PG_POOL_LOG_INTERVAL_MS` (default 30s). Uses `console.warn` deliberately: `lib/db` is a low-level lib with no logger and importing api-server's pino would invert the dependency layering; pino still captures stdout/stderr.

**Pooler is NOT needed yet (but app is safe for it):** the DB endpoint is direct (no `-pooler`), `max_connections=112`, ~10 in use. Switching to a transaction-mode pooler would remove the 112 ceiling BUT imposes a future constraint (no session-state: no session-scoped `pg_advisory_lock`, no `LISTEN/NOTIFY`). The app currently respects that (all advisory locks are `pg_advisory_xact_lock`, no LISTEN/NOTIFY), so it is safe — but right-sizing `PG_POOL_MAX` + the monitor is the zero-future-impact choice and is kept unless load actually approaches 112.
