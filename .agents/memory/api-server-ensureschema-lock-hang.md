---
name: api-server ensureSchema startup lock-hang
description: api-server fails to open its port because startup schema reconciliation blocks on relation locks held by the test workflow's stuck queries.
---

The `artifacts/api-server: API Server` workflow can fail to restart with `DIDNT_OPEN_A_PORT` even when the code is fine and the esbuild bundle succeeds. The log stops dead at `INFO ensureSchema: starting schema reconciliation (tableCount: …)` with nothing after.

**Cause:** `ensureSchema` runs DDL (CREATE/ALTER) at boot and needs relation locks. The separate `admin-reports-tests` workflow runs the full test suite against the SAME database; when one of its long queries gets stuck (e.g. the `maintenance/trend` tests spilling to disk / aborting at the 5-min limit), it holds relation locks that block `ensureSchema` indefinitely, so the port never opens.

**Why:** two processes doing heavy work on the same Postgres concurrently — boot-time DDL vs. an in-flight test transaction — deadlock on relation locks. Repeated restarts just kill `ensureSchema` mid-wait and pile up.

**How to apply:** if api-server hangs at `ensureSchema`, do NOT assume your code broke it (route-only changes can't touch schema). Inspect locks and clear the blockers:
- Find the chain: `SELECT pid, pg_blocking_pids(pid), wait_event_type FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 OR wait_event_type='Lock';`
- The root holders are the stuck test backends. `SELECT pg_terminate_backend(pid)` them (just DB sessions — not destructive to data), confirm `still_blocked=0`, then restart the api-server.
- Note: `executeSql` masks `pg_stat_activity.query`/`application_name` (shows state `disabled`, blank query), but `pid`, `wait_event_type`, and `pg_blocking_pids()` are reliable.
- More direct when `pg_blocking_pids()` comes back empty under the pooler: join `pg_locks` to `pg_class` by `relname` for the specific blocked table (usually `companies`) — the `granted=true` `AccessShareLock` holders are leaked idle-in-transaction sessions; `pg_terminate_backend()` exactly those, then the queued `AccessExclusiveLock` (the boot ALTER) drains and the port opens. Killing the always-on `admin-reports-tests` process alone is not enough; you must terminate the granted-lock backends.
