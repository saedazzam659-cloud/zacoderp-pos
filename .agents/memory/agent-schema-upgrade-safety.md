---
name: Agent schema upgrade safety
description: Safety invariants for upgrading a live full-agent database in place.
---

An agent schema upgrade must prove that the database backed up is the same database being migrated, without exposing credentials. Stop agent application traffic before the backup and keep it stopped through reconciliation and verification. Hold a database advisory lock so crash recovery cannot resume traffic while an old worker may still mutate the schema.

**Why:** The control-plane database URL and the remote app configuration can drift, and checking a lock before fencing a stale worker leaves a race where traffic resumes during DDL.

**How to apply:** Compare a non-secret canonical identity derived from host, port, database, and user before mutation. On recovery, replace the operation lease first, then hold the database lock while revoking the remote fence and resuming the service.

The upgrade worker must reuse the same external-database routing and schema-heal entry point used by agent initialization; do not invent wrapper names that are only checked by source-text tests.

**Why:** Bundling can succeed with unresolved free variables inside a deferred worker, so the defect appears only after a live upgrade starts.

**How to apply:** Run the full heal, then the strict request-readiness heal; explicitly verify posting-critical columns plus installation ID and database fingerprint before resuming traffic. Add a focused guard against unknown worker helpers.

Sequence reconciliation after restore or upgrade must coordinate with the sequence relation itself; a data-table lock plus `setval` is not sufficient because `nextval` does not use the table lock. Block table writers, take a transaction-held `ALTER SEQUENCE` lock, inspect the table/sequence state, and restart only when the stored maximum is ahead. Keep empty and already-ahead sequences unchanged.

**Why:** A concurrent allocator can obtain a stale value between `MAX(id)` and `setval`, then collide after the table lock releases; `setval` can also move a live sequence backward.

**How to apply:** Run reconciliation only inside the restore transaction or the traffic-fenced full external-agent upgrade transaction. Cover both SERIAL and IDENTITY sequences and prove with two connections that direct `nextval` blocks until repair commits.