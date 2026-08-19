---
name: Remote agent database latency
description: Safe performance rules for API paths that execute against network-remote agent PostgreSQL databases.
---

Optimize remote-agent paths primarily by reducing serial network round trips: combine independent read-only lookups, use set-based reads for per-line metadata, and overlap truly independent reads within conservative pool limits.

Do not bulk or defer inventory balance and ledger writes merely to save round trips. A stock optimization must keep the balance mutation, ledger rows, journal entry, and final document status in one database transaction, and must reserve quantity/lots conditionally under concurrency.

**Why:** Network latency makes small serial queries expensive, but a read-before-write snapshot plus later bulk mutation can oversell stock or leave balances without ledger evidence if a later step fails.

**How to apply:** Batch tenant-scoped warehouse, balance, and cost reads freely. For FIFO/FEFO or balance writes, require transaction-aware helpers, conditional quantity enforcement, deterministic lot locking/reservation, rollback tests, and concurrent-post tests before batching.