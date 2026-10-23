---
name: Manufacturing estimate versus actual
description: Read-only manufacturing route cost estimates and individual employee payroll rate basis.
---

Smart Manufacturing should show route-based resource estimates separately from actual production-order costs. Estimates are informational and must never create or alter payroll, depreciation, WIP, or journal entries.

**Why:** The user wants costs visible from route stages while keeping accounting entries unchanged; employee salaries differ and must not be flattened into one company-wide hourly average.

**How to apply:** For estimates, use each assigned employee's gross salary from a posted payroll run divided by 30 days times that employee's contractual daily hours. Apply the rate to planned stage hours. Estimate machine depreciation from planned machine hours and the linked asset's configured rate. Keep actual costs on the existing execution/order path and clearly label incomplete rates rather than treating them as zero.
