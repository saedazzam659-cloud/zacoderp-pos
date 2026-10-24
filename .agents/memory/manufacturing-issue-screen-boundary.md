---
name: Manufacturing issue screen boundary
description: The warehouse manufacturing-issue screen is read-only and reflects existing production stock-ledger movements.
---

Do not change manufacturing issue timing, quantities, or accounting when extending material-issue visibility. The warehouse issue screen is a read-only view of posted stock-ledger movements and should be available only when Production or Smart Manufacturing is enabled for the company.

For v1 Smart Manufacturing, show each stage's assigned raw-material lines with planned quantity, posted issue quantity, and issue status in the stage execution view. Keep this display read-only: posted quantity remains the frozen order BOM quantity issued at stage completion; do not add manual consumption overrides without a separate decision.

**Why:** The user confirmed that automatic stage issue should remain unchanged and chose visibility of planned and posted quantities over manual quantity entry. The existing production deduction logic remains the accounting source of truth.

**How to apply:** Read stage assignments from the order's BOM snapshot and issued state from production issue events; preserve the stock-ledger order and batch attribution in Inventory, and keep the menu/direct route gated by either company manufacturing module.
