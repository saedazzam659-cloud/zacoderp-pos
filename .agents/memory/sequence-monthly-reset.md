---
name: Sequence monthly reset (تصفير شهري)
description: Rules for the monthly-reset toggle on the document-numbering engine (zatca-invoicing web ERP, NOT pos-desktop).
---

# Monthly reset on document numbering

The web ERP numbering engine supports a per-sequence `monthly_reset` boolean. When on,
the per-branch running counter restarts at `start_number` at each new calendar month.
Detection is per-branch via `sequence_counters.last_period` ("YYYY-MM") compared against
the issuance's effective-period key.

**Rule — NULL last_period adopts the current month WITHOUT resetting.**
**Why:** a counter that pre-dates the feature (or a freshly-toggled sequence) has
`last_period = NULL`; resetting on first issuance would retroactively reuse numbers
already issued this month and collide on the document-number unique index. So a NULL
period is stamped with the current month but the counter is NOT rewound.
**How to apply:** only reset when `monthly_reset = true` AND `last_period` is non-null
AND differs from the current period. Both the issuance path and the `/peek` preview
must apply this identical condition or the preview drifts from the issued number.

**Rule — monthly_reset is hard-blocked without a month token.**
**Why:** without `{MM}`/`{M}` in `monthPattern`, every month re-issues the same formatted
string (e.g. PR-0001 in Jan AND Feb) → unique-index collision. UI hint alone is not
enough; the server `validatePayload` rejects `monthlyReset=true` unless the pattern
contains `{MM}` or `{M}`.

**Gotcha — PATCH must persist behavior toggles in BOTH places.** When adding a new
column to a sequence, it must appear in the PATCH `existing` snake_case normalization
AND in the final `tx.update(...).set({...})` — computing it only into the `merged`
object silently drops it on update. (This bit us: monthlyReset toggled on create but
not on edit until the `.set()` was fixed.)

**DB migration note:** drizzle push in this repo is interactive and wanted to truncate
an unrelated table; additive columns were applied via direct
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` instead.

## Next-number badge (peek) MUST match the issuance branch

Numbering counters are per-(sequence, branch). The `useNextSequenceNumber` peek hook
and the document form's POST must target the SAME branch, or the badge reads the
wrong counter.
**Symptom:** badge frozen at the start number (e.g. QU-05-0001) while each save
increments correctly. **Cause:** the form submits a selected `branchId` (e.g. main
branch) so issuance advances that branch's counter, but the peek hook sent no branch
→ it read the company-wide branch-0 sentinel (empty) and fell back to `start_number`.
**Why:** the server peek defaults `branchId` to 0; the form's branch selector is the
only thing that knows which branch will actually be submitted.
**How to apply:** any form that submits a branch AND shows a next-number badge must
pass that branch as the 4th arg of `useNextSequenceNumber(txType, enabled, date,
branchId)`. Other branch-bearing forms (sales/purchase/inventory) share this latent
bug if they omit the branch arg.
