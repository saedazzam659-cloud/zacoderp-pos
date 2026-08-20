---
name: Remote agent database latency
description: Safe performance rules for API paths that execute against network-remote agent PostgreSQL databases.
---

Optimize remote-agent paths primarily by reducing serial network round trips: combine independent read-only lookups, use set-based reads for per-line metadata, and overlap truly independent reads within conservative pool limits.

Do not bulk or defer inventory balance and ledger writes merely to save round trips. A stock optimization must keep the balance mutation, ledger rows, journal entry, and final document status in one database transaction, and must reserve quantity/lots conditionally under concurrency.

**Why:** Network latency makes small serial queries expensive, but a read-before-write snapshot plus later bulk mutation can oversell stock or leave balances without ledger evidence if a later step fails.

The pair-lock protocol must be system-wide: protecting one sales path does not prevent a legacy purchase/return/production writer from reading an old balance, waiting on its update, then overwriting the newer quantity.

**How to apply:** Batch tenant-scoped warehouse, balance, and cost reads freely. For FIFO/FEFO or balance writes, use the same deterministic exact-pair lock order in every writer, reload after locking, keep balance+ledger+document status in one transaction, and require rollback plus cross-document concurrency tests before batching.

## Agent-domain startup traffic

Shell-agent domains share the central runtime while routing data to a remote agent DB. Per-boot compatibility reconciliation must be single-flight and **fail closed**: no downstream query or mutation may run until a strict columns/enums readiness pass succeeds. A bounded wait may return retryable 503, but never serve against a partially reconciled schema.

**Why:** Awaiting the old full remote scan made the first request hang for roughly 160 seconds; detaching it into the background then let sales queries race missing columns and return HTTP 500. The full scan was slow because it replayed a large serial identity/table/index DDL list over the network.

**How to apply:** Request readiness uses the fast strict columns/enums pass only; any DDL failure or required missing table returns 503 and evicts the failed flight for retry. Full structural reconciliation remains an explicit init/preflight operation. Tests must prove pending/failed heals never call downstream handlers.