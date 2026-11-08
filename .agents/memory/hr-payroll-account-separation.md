---
name: HR payroll account separation
description: User-approved boundaries for mapping payroll components to company chart accounts.
---

Payroll expense components such as basic salary, housing, transport, other allowances, overtime, and bonuses must map independently. Keep the existing general allowances mapping for other allowances. Require distinct selected expense accounts, and block posting when a nonzero component has no mapping.

Do not invent standard chart codes for newly separated payroll components. Account codes and structure are company-specific; let the administrator select an existing posting account or create one through the chart-of-accounts workflow. Existing HR mappings remain in effect unless explicitly changed.

Do not calculate or post employer-paid GOSI without an explicitly approved employer contribution rule. Employee deductions and the existing GOSI account mappings do not establish the employer rate.

**Why:** Guessing account codes or insurance rates can misclassify payroll expense and create unsupported liabilities.

**How to apply:** Keep component fields manually selectable, validate company ownership/type and uniqueness, and fail closed before posting when a used component is unmapped. Preserve employee GOSI behavior separately from any future employer-share calculation.
