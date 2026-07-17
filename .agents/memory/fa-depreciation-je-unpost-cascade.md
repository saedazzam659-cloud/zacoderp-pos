---
name: FA depreciation JE unpost cascade
description: fa_depreciation JEs must cascade unpost to the run; legit vs broken draft shapes distinguished by postedAt
---

Rule: a `fa_depreciation` JE is owned by its `fa_depreciation_runs` row. Any JE-grid action must route through the run helpers, never bare status flips:
- JE `/unpost` → cascade to `unpostDepreciationRun` (reverses asset accum/bookValue, reserves the JE number, DELETES the JE, flips run to `unposted`). Cascade branch sits BEFORE the `status!=='posted'` early return so it also heals legacy-broken drafts.
- JE PUT/DELETE → 403 while a run references the JE.
- JE `/post` → 409 ONLY for a run-linked draft with `postedAt != null` (legacy-broken, stale amounts); a `postedAt == null` draft is a LEGITIMATE auto-post-OFF JE and must stay postable (plain flip).
- Schedule tab `postedSet` must filter runs by `status='posted'`.
- Asset PUT runs `healDraftLinkedRuns` (run posted + JE draft + postedAt NOT NULL, newest-first, best-effort) before catch-up.

**Why:** the old bare flip left run='posted' + asset accum applied → schedule kept showing "تم ترحيلها" and asset edits never reached the stale draft JEs. Repost (`repostDepreciationRun`) recomputes day-based from CURRENT asset state, so amounts self-heal only via the FA unpost→repost flow.

**How to apply:** `postedAt` is the discriminator between "was posted once then broken" and "awaiting first manual post" — fa-journals stamps it only when the JE lands posted, and no flip clears it. Any new source-doc type with its own run/ledger row needs the same cascade treatment (fa_depreciation is NOT in LOCKED_ENTRY_TYPES by design, because unpost must cascade rather than 403).
