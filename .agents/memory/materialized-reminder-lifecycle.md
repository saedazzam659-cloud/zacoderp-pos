---
name: Materialized reminder lifecycle
description: Prevent durable notification rows from becoming false alerts after their source changes.
---

Lazy notification materialization must reconcile the full active source-key set: delete rows whose source is no longer eligible, insert missing rows idempotently, and refresh descriptive fields on still-current rows without replacing them.

**Why:** A source key containing an end date prevents duplicate inserts, but a renewal, correction, or deletion changes/removes that key while leaving the old high-severity row permanently visible. Replacing current rows unnecessarily would also lose per-user read and dismissal receipts.

**How to apply:** For any reminder materialized from mutable records, calculate active source keys per tenant and category, retract keys outside that set, then upsert content while preserving the identity of current notification rows.