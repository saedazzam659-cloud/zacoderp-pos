---
name: Company hard-purge sequence boundary
description: How permanent company deletion may remove sequence-protected documents without weakening normal protections.
---

A confirmed SuperAdmin permanent purge may delete sequence-protected documents only inside the purge transaction, scoped to the exact company and serialized with sequence activation. Revalidate that the company is still soft-deleted while holding the company row lock. Never disable sequence protection globally or persist a bypass marker.

Immutable evidence tables may allow DELETE only when the transaction-local reset or purge marker matches `OLD.company_id`; their UPDATE protection remains unconditional. Such child rows must be removed before restrictive stock/accounting parents.

**Why:** Permanent purge is the explicit path for erasing every record of a company, while ordinary document deletion and edits must continue to preserve fiscal numbers and immutable evidence. Matching the row tenant makes the exception narrow and race-safe.

**How to apply:** Ensure the active database's immutable-trigger functions are purge-aware, acquire the sequence-protection advisory lock before the company row lock, set a transaction-local purge marker for the target company, and keep the recycle-bin confirmation requirement. Any failure must roll back the entire purge.
