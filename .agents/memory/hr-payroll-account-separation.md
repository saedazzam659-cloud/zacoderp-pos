---
name: HR payroll account separation
description: User-approved boundaries for mapping payroll components to company chart accounts.
---

Payroll expense components such as basic salary, housing, transport, other allowances, overtime, and bonuses must map independently. Keep the existing general allowances mapping for other allowances. Require distinct selected expense accounts, and block posting when a nonzero component has no mapping.

The user approved standard expense accounts 5219 (housing), 5220 (transport), 5221 (overtime), and 5222 (bonuses), and these may be auto-linked when HR is enabled. Do not invent codes for any other newly separated payroll components. Existing valid HR mappings remain in effect unless explicitly changed.

Do not calculate or post employer-paid GOSI without an explicitly approved employer contribution rule. Employee deductions and the existing GOSI account mappings do not establish the employer rate.

**Why:** These four codes were explicitly approved to make HR activation complete; further guessed codes or insurance rates could misclassify payroll expense or create unsupported liabilities.

**How to apply:** Use the four approved codes only for their matching HR expenses, preserve manual company mappings, validate ownership/type and uniqueness, and fail closed before posting when a used component is unmapped. Preserve employee GOSI behavior separately from any future employer-share calculation.
