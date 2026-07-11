---
name: FA movement-schedule classification (opening-balance vs additions)
description: How the fixed-assets depreciation movement schedule classifies رصيد أول vs إضافات, and why the GL-reconciliation row was removed.
---

# Fixed-assets movement schedule (جدول الإهلاك) classification

`GET /api/fixed-assets/reports/movement-schedule` (fixed-assets.ts) builds a
depreciation/movement schedule grouped by the main asset **cost** COA account,
reporting STRICTLY from the registered `fixed_assets` rows (no GL reconciliation).

**Rule (current, by explicit user decision): classification is FLAG-driven, not
date-driven.**
- `is_opening_balance = true` asset → its cost goes to **رصيد أول (cost.opening)**,
  and its accumulated depreciation load goes to **مجمع الإهلاك رصيد أول
  (dep.opening)** — regardless of purchase date.
- Every OTHER registered asset → **إضافات (cost.additions)**, regardless of
  purchase date (a normal purchase, even from a prior year, is an addition here).
- In-period disposals still reduce via **exclusions**.
- `dep.opening = runsBefore + ((acquiredBefore || isOpeningBalanceAsset) ?
  openingBalanceAccum : 0)`; `openingBalanceAccum = max(0, curAccum − Σruns)`.

**Why:** the opening-balance tool (assets entered WITHOUT an acquisition JE) must
land in رصيد أول so opening balances are never treated as period additions and are
never silently dropped when their purchase date is null/in-period. The owner wants
رصيد أول reserved exclusively for opening-balance-tool assets.

**Removed — do not re-add without asking:** the old "حركات غير مربوطة بأصل
(قيود/فواتير)" GL-reconciliation row (and its per-request posted-GL fetch) was
removed by request. Because opening-balance assets post NO JE, the GL never matched
the registry and produced spurious reconciliation rows. The report no longer ties
to GL by design. The old shared-accum-account residual math (compute residual PER
accum account, attribute to a primary cost group) is gone with it; a small dead
accum→cost map is still built in-memory but unused.

**Still applies:** only `status='posted'` JEs feed depreciation runs; branch-scope
the assets list via `branchScopeSpread`. Group/grand totals sum from `g.rows` only.
