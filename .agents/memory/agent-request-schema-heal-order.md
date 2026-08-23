---
name: Agent request schema heal order
description: Prevent initialized agent databases from getting stuck behind strict request-time schema checks after a central release.
---

If a new agent-side table has complete additive DDL, execute that DDL before the strict generic missing-table validation used by request-time agent routing. Do not merely mark the table optional.

**Why:** Generic reconciliation intentionally cannot create arbitrary missing tables. If strict validation runs first, it rejects the request before the specialized idempotent table creator can run, causing every login to return `AGENT_SCHEMA_FAILED` forever.

**How to apply:** Put narrowly scoped `CREATE TABLE/INDEX IF NOT EXISTS` preflights before `ensureColumns(... strict:true)`, fail closed if their DDL fails, and keep unrelated missing tables blocking.