---
name: Manufacturing source cost policy
description: Single-screen wizard and accounting ownership of allocated manufacturing costs.
---
Use one invoice-style tabbed manufacturing form over the existing core, not a separate execution engine. Source linkage configuration belongs in existing assets, payroll, and prepaid-expense screens.

**Why:** The user explicitly chose a compact single-screen workflow and required reuse of existing modules rather than duplicated screens and accounting.

Allocated posted costs must reclassify the original expense debit accounts into WIP, not book another expense or use unrelated generic offsets. Fixed assets still own depreciation and payroll still owns salary accounting. Use approved allocation denominators/rates, not arbitrary source percentages.

**Why:** Already-posted source costs otherwise get counted twice or leave the wrong expense accounts overstated.

**How to apply:** Preserve source/configuration snapshots, capacity caps and cancellation release together. Every production status write, stock movement, journal and number claim must share the same transaction; propagate the executor through helper calls.