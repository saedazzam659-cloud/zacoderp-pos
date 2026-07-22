---
name: Adjustments anniversary posting schedule
description: Monthly prepaid/accrued adjustment installments post on the start-date anniversary day, one full month after start — plus legacy-key compatibility rules.
---

Rule: `monthsBetween` (duplicated in lib/adjustmentPosting.ts AND routes/adjustments.ts — keep in LOCKSTEP) yields installment k at startDate + k months on the START day-of-month (clamped to short months). Start 2025-11-22 → first run 2025-12-22 … 2026-05-22 (day-aware count: partial end month dropped).

**Why:** user requirement — old scheme posted at END of the start month (2025-11-30 first), which read as "قسط قبل ما يستحق". Anniversary matches rental/prepaid contract expectations.

**How to apply / compat traps:**
- Legacy runs carry `period_month` keys shifted ONE MONTH EARLIER than the new schedule. Any loop over the schedule must cap at total installment count (`generated.size >= totalMonths → break`) or a partially/fully posted legacy adjustment mints one extra run.
- Re-spread on edit must be COUNT-based (`scheduled − booked runs`), never YM-name intersection, or legacy keys inflate remainingMonths and corrupt monthlyAmount.
- Already-posted legacy JEs keep their old dates; correcting them requires unpost/delete of the runs and regeneration.
