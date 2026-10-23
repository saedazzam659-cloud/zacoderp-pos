---
name: Manufacturing estimate versus actual
description: Read-only manufacturing route cost estimates and individual employee payroll rate basis.
---

Smart Manufacturing should show planned and executed route-resource costs separately from posted production-order costs. This comparison is informational and must never create or alter payroll, depreciation, WIP, order costs, or journal entries.

**Why:** The user wants costs visible from route stages while keeping accounting entries unchanged; employee salaries differ and must not be flattened into one company-wide hourly average.

**How to apply:** Use each stage employee's gross salary from the latest posted payroll run appropriate to the stage period, divided by 30 days times that employee's contractual daily hours. Apply it to planned duration for planned cost and actual duration for executed-resource analysis. Require recorded employee IDs/count to agree before showing actual labor. Use linked-asset rates for depreciation, and label current electricity tariff use and missing inputs clearly. Keep accounting/posting costs unchanged.
