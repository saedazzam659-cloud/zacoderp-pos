---
name: HR monthly provision policy
description: User-approved basis for monthly leave, end-of-service, and travel-ticket accruals.
---

Monthly leave provision is eligible monthly salary multiplied by annual vacation days in the employee contract, divided by 360. Monthly EOS provision is the change in the employee's statutory liability calculated using the existing EOS calculator. Monthly travel-ticket provision is the employee's annual ticket entitlement divided by 12. The monthly payroll journal is the sole accounting posting path; the payroll run remains calculation and review. Settlement or use reduces the provision rather than charging the same cost again.

Monthly provision posting is explicitly enabled per company and defaults off. Existing companies must not begin accruing liabilities merely because the software was upgraded.

**Why:** The user explicitly approved these formulas and the monthly-journal ownership boundary on 2026-11-07.

**Why:** Enabling new expense/liability entries without reviewed mappings and employee entitlements could change existing ledgers unexpectedly.

**How to apply:** Capture the annual ticket entitlement per employee, preserve period snapshots for each posted month, and connect the resulting employee cost to manufacturing only once. The eligible salary components for leave accrual were not specified beyond the user's approval of the eligible-salary basis.

Settlement decisions: paid-leave provision is settled with a separate entry when the leave is used; travel-ticket provision is settled against the actual ticket invoice or expense. Keep monthly provision activation off until manufacturing allocation, settlement, and consolidated reporting are complete.

**Why:** The user confirmed these settlement sources on 2026-11-08 and required the activation gate to remain off until the related workflows are complete.

**How to apply:** Link each settlement to its source employee and provision period, reduce the liability without charging the same cost twice, and preserve posted snapshots.

Freeze employee provision amounts on first payroll posting, including explicit zeros when accrual is disabled. Reposting must reuse the original period basis, not current entitlements.

**Why:** Later activation or contract changes must not retroactively recognize costs absent from the original payroll period.

**How to apply:** Treat uncaptured historical amounts as unknown rather than reconstructing liabilities from today's contract.
