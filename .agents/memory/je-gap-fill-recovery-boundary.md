---
name: Journal-entry gap-fill claim recovery
description: Safely recreating a deleted blank draft from the sequence-repair screen.
---

When a requested journal number has no active journal row, allow the sequence-repair screen to recreate it as a blank general draft only if its permanent claim is explicitly marked `journal_entries` / `gap_fill`. Preserve the operator-entered date and leave sequence counters unchanged. Reject claims with any other or missing provenance; never bypass a live journal row or an uncertain/source-linked claim.

**Why:** The permanent claim registry intentionally survives deletion to prevent accidental number reuse, but that blocks the explicit workflow for restoring a previously gap-filled draft. A narrow provenance marker supports that recovery without treating every stale claim as safe.

**How to apply:** Perform the existing-row check and claim inspection under the per-company transaction lock. Reuse the original gap-fill claim in the same transaction as inserting the new draft, and audit which claims were recovered.
