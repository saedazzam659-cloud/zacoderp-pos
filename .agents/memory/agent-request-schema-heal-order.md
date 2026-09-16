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