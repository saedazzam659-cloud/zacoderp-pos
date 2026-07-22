---
name: Adjustments anniversary posting schedule
description: Monthly prepaid/accrued adjustment installments post on the start-date anniversary day, one full month after start — plus legacy-key compatibility rules.
---

Rule: `monthsBetween` (duplicated in lib/adjustmentPosting.ts AND routes/adjustments.ts — keep in LOCKSTEP) yields installment k at startDate + k months on the START day-of-month (clamped to short months). Start 2025-11-22 → first run 2025-12-22 … 2026-05-22 (day-aware count: partial end month dropped).

**Why:** user requirement — old scheme posted at END of the start month (2025-11-30 first), which read as "قسط قبل ما يستحق". Anniversary matches rental/prepaid contract expectations.

**How to apply / compat traps:**
- Legacy runs carry `period_month` keys shifted ONE MONTH EARLIER than the new schedule. Any loop over the schedule must cap at total installment count (`generated.size >= totalMonths → break`) or a partially/fully posted legacy adjustment mints one extra run.
- Re-spread on edit must be COUNT-based (`scheduled − booked runs`), never YM-name intersection, or legacy keys inflate remainingMonths and corrupt monthlyAmount.
- Already-posted legacy JEs keep their old dates; unpost keeps the run row AND the draft JE (same docNumber, OLD date) — re-posting alone restores old dates.
- Fix path: `POST /:id/reschedule-draft-runs` maps runs (sorted by period_month, index k) → schedule slot k and rewrites DRAFT runs only: run.period_month + JE entryDate/periodId + month label in JE & line descriptions. Two-phase `tmp-<runId>` keys dodge the (adjustment_id, period_month) unique index; targets colliding with an immovable (posted/skipped) run's key are skipped with an explicit reason, never 500. docNumbers untouched.

## Amount correction (reschedule-draft-runs)
Legacy adjustments created under the old end-of-month scheme stored monthlyAmount = total/(n+1) (e.g. 69,000 over 6 anniversary installments split by 7 → 9,857.14 + dangling residual). The reschedule-draft-runs endpoint now also RE-SPREADS amounts: remaining = round2(total − Σ immovable run amounts) over the movable drafts, last installment absorbs rounding delta so balance closes to exactly 0; updates run.amount, JE lines (targeted by adjustment's expense/contra accountId, never bare debit>0), and syncs adjustments.monthlyAmount. Hard 409 guard on negative remainder. Posted JEs untouched — user flow: unpost → press button → re-post.
