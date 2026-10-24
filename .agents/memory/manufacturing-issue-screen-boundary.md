---
name: Manufacturing issue screen boundary
description: The warehouse manufacturing-issue screen is read-only and reflects existing production stock-ledger movements.
---

Do not change manufacturing issue timing, quantities, or accounting when extending material-issue visibility. The warehouse issue screen is a read-only view of posted stock-ledger movements and should be available only when Production or Smart Manufacturing is enabled for the company.

For v1 Smart Manufacturing, show each stage's assigned raw-material lines with planned quantity, posted issue quantity, and issue status in the stage execution view. Keep this display read-only: posted quantity remains the frozen order BOM quantity issued at stage completion; do not add manual consumption overrides without a separate decision.

The user has approved a separate per-material raw-waste entry at stage execution. It is an additional quantity in that material's own unit, with a reason; it never edits the frozen BOM quantity. The stock issue is planned BOM quantity plus recorded material waste, posted once with stage completion. Keep it separate from product/output waste, and capitalize the material cost to WIP under the v1 stage-costing policy.

**Why:** The user confirmed that automatic stage issue should remain unchanged and chose visibility of planned and posted quantities over manual quantity entry. The existing production deduction logic remains the accounting source of truth.

**How to apply:** Read stage assignments from the order's BOM snapshot and issued state from production issue events; preserve the stock-ledger order and batch attribution in Inventory, and keep the menu/direct route gated by either company manufacturing module.

**Why:** The user separately approved recording raw-material damage without changing recipe/order quantities. Existing v1 policy keeps stage material cost in WIP; do not assume an abnormal-material-waste expense split without an explicit accounting decision.

**How to apply:** Validate raw waste against the assigned stage line, persist it with execution evidence, include it in the one stage stock issue and issue journal, and preserve exact rollback/reissue behavior.
