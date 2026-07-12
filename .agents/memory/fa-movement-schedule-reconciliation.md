---
name: FA movement-schedule classification (opening-balance vs additions)
description: How the fixed-assets depreciation movement schedule classifies رصيد أول vs إضافات, and why the GL-reconciliation row was removed.
---

# Fixed-assets movement schedule (جدول الإهلاك) classification

`GET /api/fixed-assets/reports/movement-schedule` (fixed-assets.ts) builds a
depreciation/movement schedule grouped by the main asset **cost** COA account,
reporting STRICTLY from the registered `fixed_assets` rows (no GL reconciliation).

**Rule (current, revised by user Jul 2026): classification is FLAG-OR-DATE
driven.**
- **رصيد أول (cost.opening)** = `is_opening_balance = true` assets (any date)
  PLUS any asset acquired BEFORE the report period start (`purchaseDate < from`).
  An asset bought in 2025 rolls into رصيد أول when viewing 2026 — it must NOT
  repeat as an addition every year.
- **إضافات (cost.additions)** = assets acquired WITHIN the period, plus
  no-purchase-date non-flag assets (never silently dropped).
- In-period disposals still reduce via **exclusions**.
- `dep.opening = runsBefore + ((acquiredBefore || isOpeningBalanceAsset) ?
  openingBalanceAccum : 0)`; `openingBalanceAccum = max(0, curAccum − Σruns)` —
  the dep side was ALWAYS date-driven; the cost side now matches it.

**History:** an earlier explicit decision made the cost side flag-ONLY (every
non-flag asset = addition regardless of date); the user reversed that when 2026
showed prior-year purchases as إضافات with رصيد أول = 0. The flag path still
exists so opening-balance-tool assets (null/in-period dates, no JE) always land
in رصيد أول.

**Removed — do not re-add without asking:** the old "حركات غير مربوطة بأصل
(قيود/فواتير)" GL-reconciliation row (and its per-request posted-GL fetch) was
removed by request. Because opening-balance assets post NO JE, the GL never matched
the registry and produced spurious reconciliation rows. The report no longer ties
to GL by design. The old shared-accum-account residual math (compute residual PER
accum account, attribute to a primary cost group) is gone with it; a small dead
accum→cost map is still built in-memory but unused.

**Still applies:** only `status='posted'` JEs feed depreciation runs; branch-scope
the assets list via `branchScopeSpread`. Group/grand totals sum from `g.rows` only.
