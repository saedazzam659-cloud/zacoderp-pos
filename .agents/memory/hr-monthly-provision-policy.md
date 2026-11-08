---
name: HR monthly provision policy
description: User-approved basis for monthly leave, end-of-service, and travel-ticket accruals.
---

Monthly leave provision is basic monthly salary only (excluding all allowances) multiplied by annual vacation days in the employee contract, divided by 360. Monthly EOS provision is the change in the employee's statutory liability calculated using the existing EOS calculator. Monthly travel-ticket provision is the employee's annual ticket entitlement divided by 12. The monthly payroll journal is the sole accounting posting path; the payroll run remains calculation and review. Settlement or use reduces the provision rather than charging the same cost again.

Monthly provision posting is explicitly enabled per company and defaults off. Existing companies must not begin accruing liabilities merely because the software was upgraded.

**Why:** The user explicitly approved these formulas and the monthly-journal ownership boundary on 2026-11-07.

**Why:** Enabling new expense/liability entries without reviewed mappings and employee entitlements could change existing ledgers unexpectedly.

**How to apply:** Capture the annual ticket entitlement per employee, preserve period snapshots for each posted month, and connect the resulting employee cost to manufacturing only once. Leave accrual and use are based on basic salary only; never include housing, transport, or other allowances.

**Why:** On 2026-11-08 the user explicitly selected “الأساسي فقط” for the leave provision salary basis. This clarification is prospective; preserve all previously posted period snapshots.

Paid-leave provision is settled with a separate entry when leave is used; travel-ticket provision is settled against the actual ticket invoice or expense. After payroll, balance, settlement, reversal, and manufacturing-offset verification passes, allow each company to opt in; keep existing companies off until they explicitly enable it. Never backfill runs posted before activation.

**Why:** On 2026-11-09 the user chose to complete lifecycle verification and unlock the setting after noticing missing journal lines. This supersedes the earlier temporary system-wide activation gate, but not the company-level opt-in or no-backfill boundary.

**How to apply:** Keep the feature default-off for each company; add new accruals only when that company opts in and posts a payroll run. Link each settlement to its source employee and provision period, reduce liabilities without duplicate expense, preserve posted snapshots, and keep manufacturing offsets/reversal guards in place.

Freeze employee provision amounts on first payroll posting, including explicit zeros when accrual is disabled. Reposting must reuse the original period basis, not current entitlements.

**Why:** Later activation or contract changes must not retroactively recognize costs absent from the original payroll period.

**How to apply:** Treat uncaptured historical amounts as unknown rather than reconstructing liabilities from today's contract.

Keep the liability accrual period separate from the month in which leave salary is actually expensed. Leave use must consume posted basic salary only; ticket use must consume real posted ticket expense, never a supplier payment or tax amount.

**Why:** Crediting an expense without preserving its source allocation would leave manufacturing capitalizing the same funded cost again, or put the reversal on a different cost center.

**How to apply:** Freeze the original expense and cost-center split, subtract the funded portion from the manufacturing source, and reject create/reverse while that source is allocated or frozen by a period closure.
