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

Per-boot additive schema reconciliation for an external agent database must run single-flight in the background. Agent-domain middleware must enter the existing database context and serve login/invoice traffic immediately rather than awaiting the full remote schema scan.

**Why:** A central publish once made the first agent request wait behind reconciliation for roughly 160 seconds; the session request timed out and made a healthy company look stopped even though its data was intact.

**How to apply:** Keep reconciliation tenant-bound and retryable, but never put its promise on the request critical path. Regression tests must hold the heal promise open and prove multiple requests proceed immediately while only one heal runs.