---
name: Manufacturing cost-source defaults
description: Default source-linking behavior and payroll attribution boundary in Smart Manufacturing.
---

New Smart Manufacturing orders should default payroll, fixed-asset depreciation, and prepaid-amortization cost modes to linked posted sources. Explicit user-saved mode preferences and template settings remain authoritative; choosing linked mode must not automatically select or allocate a source.

**Why:** The owner wants the Costs tab to open ready to use posted evidence, while preserving deliberate per-user or template choices and preventing accidental cost allocation.

**How to apply:** Keep source selection separate from mode selection. Treat supervision employees as part of the existing payroll source; do not add a second supervision source unless an approved allocation split can divide, not duplicate, the payroll amount.
