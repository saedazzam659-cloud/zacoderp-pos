---
name: Manufacturing issue screen boundary
description: The warehouse manufacturing-issue screen is read-only and reflects existing production stock-ledger movements.
---

Do not change manufacturing issue timing, quantities, or accounting when extending the warehouse issue screen. It is a read-only view of posted production stock-ledger movements and should be available only when Production or Smart Manufacturing is enabled for the company.

**Why:** The user clarified that the current production deduction logic is correct; the request is only to make the already-deducted raw-material quantities easy to find in Inventory.

**How to apply:** Read from the existing stock ledger, preserve its order and batch attribution, and keep the menu and direct route gated by either company manufacturing module.
