---
name: Agent schema upgrade safety
description: Safety invariants for upgrading a live full-agent database in place.
---

An agent schema upgrade must prove that the database backed up is the same database being migrated, without exposing credentials. Stop agent application traffic before the backup and keep it stopped through reconciliation and verification. Hold a database advisory lock so crash recovery cannot resume traffic while an old worker may still mutate the schema.

**Why:** The control-plane database URL and the remote app configuration can drift, and checking a lock before fencing a stale worker leaves a race where traffic resumes during DDL.

**How to apply:** Compare a non-secret canonical identity derived from host, port, database, and user before mutation. On recovery, replace the operation lease first, then hold the database lock while revoking the remote fence and resuming the service.

The upgrade worker must reuse the same external-database routing and schema-heal entry point used by agent initialization; do not invent wrapper names that are only checked by source-text tests.

**Why:** Bundling can succeed with unresolved free variables inside a deferred worker, so the defect appears only after a live upgrade starts.

**How to apply:** Add a focused guard that rejects unknown helper references in the worker, and validate the installation ID and stored database fingerprint after reconciliation before resuming traffic.