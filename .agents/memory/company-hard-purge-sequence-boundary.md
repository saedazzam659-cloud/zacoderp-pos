---
name: Company hard-purge sequence boundary
description: How permanent company deletion may remove sequence-protected documents without weakening normal protections.
---

A confirmed SuperAdmin permanent purge may delete sequence-protected documents only inside the purge transaction, scoped to the exact company and serialized with sequence activation. Revalidate that the company is still soft-deleted while holding the company row lock. Never disable sequence protection globally or persist a bypass marker.

**Why:** Permanent purge is the explicit path for erasing every record of a company, while ordinary document deletion must continue to preserve issued fiscal numbers. The transaction-local marker makes the exception narrow and race-safe.

**How to apply:** Acquire the sequence-protection advisory lock before the company row lock, set a transaction-local purge marker for the target company, and keep the existing recycle-bin confirmation requirement. Any failure must roll back the entire purge.
