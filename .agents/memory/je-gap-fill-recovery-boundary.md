---
name: Journal-entry gap-fill claim recovery
description: SuperAdmin recovery behavior for old number claims in sequence repair.
---

When a SuperAdmin requests a journal number that has no active journal row, allow the sequence-repair screen to reuse any old permanent claim and recreate the number as a blank general draft. Preserve the operator-entered date and leave sequence counters unchanged. If a journal row still exists for the number, reject creation rather than producing a duplicate; do not alter that row from the gap-fill action.

**Why:** The user explicitly authorized SuperAdmin to restore orphaned numbers as general drafts even when their original claim came from a different process or manual entry. The active-row check prevents duplicate journal numbers, while the SuperAdmin repair action may take ownership of an orphaned claim.

**How to apply:** Perform the existing-row check and claim inspection under the per-company transaction lock. Convert any old claim to the gap-fill marker and insert the draft in the same transaction; audit the original claim provenance and which numbers were recovered.
