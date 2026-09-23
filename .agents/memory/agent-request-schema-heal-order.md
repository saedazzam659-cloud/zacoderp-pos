---
name: Agent request schema heal order
description: Prevent initialized agent databases from getting stuck behind strict request-time schema checks after a central release.
---

If a new agent-side table has complete additive DDL, execute that DDL before the strict generic missing-table validation used by request-time agent routing. Do not merely mark the table optional.

**Why:** Generic reconciliation intentionally cannot create arbitrary missing tables. If strict validation runs first, it rejects the request before the specialized idempotent table creator can run, causing every login to return `AGENT_SCHEMA_FAILED` forever.

**How to apply:** Put narrowly scoped `CREATE TABLE/INDEX IF NOT EXISTS` preflights before `ensureColumns(... strict:true)`, fail closed if their DDL fails, and keep unrelated missing tables blocking.

Schema-initialization success must be scoped to the active database, not the process. Clear failed initialization promises so retries remain possible.

**Why:** A process may initialize the central database before entering an external-agent database context. Reusing central success silently skips the external DDL even when migration order is correct.

**How to apply:** Audit every memoized table initializer invoked by multi-database routing; a fulfilled promise for one database is never evidence that another database has that schema.

External-agent upgrades must establish their own FK prerequisites before creating dependent tables; a successful staged central Publish is not evidence that an external database has those keys or columns.

**Why:** External databases bypass the managed central schema diff. Enabling relationships after central prerequisites publish can break their older schemas, including diagnostics that query columns before generic reconciliation.

**How to apply:** Order additive target-key creation before dependent table/FK DDL, create narrowly scoped compatibility columns before generic reconciliation, then validate integrity afterward. Classify legacy records only at marker introduction, never promote later invalid records to legacy on every boot.

Configured external databases must never fall back to central tenant data when their status is unready, even with invoice acceleration disabled.

**Why:** A schema failure otherwise turns into a misleading unknown-company login response from the central database and risks routing business requests to the wrong data source.

**How to apply:** Return a retryable database-readiness error before authentication or business handlers. Preserve central-only behavior only for agents without a configured external database.