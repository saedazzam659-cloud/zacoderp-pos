---
name: FA catch-up depreciation on asset save
description: Auto-posting missing monthly depreciation runs when an asset is created/edited, and the concurrency guard that makes it safe.
---

# Fixed-asset catch-up depreciation on save

On asset SAVE (create `POST /assets` + edit `PUT /assets/:id`) the server auto-posts
every MISSING monthly depreciation run from the asset's depreciation-start month up to
the **last COMPLETED** KSA month (previous calendar month — the partial current month is
never posted, matching the auto-scheduler). Helper: `postDepreciationCatchUpForAsset`
in `depreciationPosting.ts`; wired via a gated best-effort `runDepreciationCatchUp` in
`fixed-assets.ts`.

**Rule:** the catch-up is gated on the company `autoPostFaDepreciation` flag (same switch
the scheduler honours, default ON) and is fully non-fatal — a failure must never break the
asset save. JE-build failures are non-fatal too (run row stays, retry from مركز الترحيل).

**Why the accum chain is consistent:** start the local `accum` from the asset's stored
`accumulatedDepreciation` and SKIP any period that already has a run row (ANY status).
Stored accum already reflects every existing run (posted lowered book; unpost reversed the
asset AND kept the row), so skipping existing periods neither double-counts nor gaps, and a
month the user intentionally unposted is not resurrected.

**Concurrency guard (critical):** the app-level `SELECT existing → INSERT` check RACES under
two rapid saves (double-click) and could double-post a month. Fixed with a DB unique index
`uq_fa_dep_run_period` on `fa_depreciation_runs (company_id, asset_id, period_month, period_year)`
plus `.onConflictDoNothing().returning()` on BOTH insert paths (scheduler
`postDepreciationForCompany` and catch-up). When the insert returns no row it means a
concurrent caller owns that period → skip WITHOUT advancing the accum chain (no double-post).

**How to apply:** any NEW path that inserts a depreciation run must also use
`onConflictDoNothing` against this index, or it will throw on a duplicate period instead of
skipping. Without the index (e.g. before it ships to prod at publish), `onConflictDoNothing`
simply never conflicts and falls back to the old app-level check — safe, just not race-proof
until the index exists.
