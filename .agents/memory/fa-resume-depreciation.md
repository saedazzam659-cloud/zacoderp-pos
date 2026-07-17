---
name: FA resume-mode depreciation (المجمع حتى تاريخ)
description: accumAsOf resume mode — remaining base over remaining life days; frozen snapshot rule
---

Fixed assets support "المجمع حتى تاريخ" (`fixed_assets.accum_as_of`): the manually-entered opening accumulated depreciation is treated as covering the life UP TO that date (inclusive). Charging resumes the next day and the REMAINING base (purchase − scrap − opening accum) is spread over the REMAINING life days, so the asset finishes exactly on its original last life day. NULL = legacy full-life daily rate, byte-identical.

**Rules:**
- **Life anchor = PURCHASE date in resume mode**: when `accum_as_of` is set, the 84-month life window anchors at `purchaseDate` (if earlier than depreciationStart and ≥ purchase) — NOT the form's depreciationStart (often auto-set to asOf+1), or a 7y/2022 asset resumes 7 MORE years from 2025 → ends 2032 instead of 2029. Legacy (no asOf) path unchanged; expired-life guard returns null (never clamp to 1 day → huge rate).
- Straight-line ONLY. Both the calc (`lifeWindow` in depreciationCalc.ts) and the catch-up fast-forward gate on `depreciationMethod === "straight_line"` — declining_balance must stay untouched.
- **Frozen snapshot is mandatory**: the rate must derive from `accum_as_of_amount` (frozen at save time), NEVER the live `accumulated_depreciation` — the live column rolls up with every monthly run and would shrink/drift the daily rate each month.
- PUT re-freeze: when `accumAsOf` is sent without `accumulatedDepreciation`, fall back to the CURRENT stored accum — never force 0 (zeroing the snapshot inflates the resume rate).
- Catch-up fast-forwards the loop to the resume month (months ≤ asOf compute 0 anyway); the resume month itself charges pro-rata days only.
- Caps stay global: `remaining = purchase − scrap − rolling accum` still uses the LIVE accum (correct — it bounds total, not rate).

**Why:** without resume mode, an asset with opening accum catch-up-posts from the start month at the full-life rate and finishes years early (user's أثاث case: 7y from 2022-11, accum through 2025-05-21).
