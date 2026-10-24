---
name: Production-order reconfiguration boundary
description: Safe reconfiguration rules for an existing Smart Manufacturing order.
---

Reconfigure the same order only before stock issue/receipt, recorded stage execution, quality or waste evidence, or any linked production-cost allocation. Rebuilding keeps the order identity and audit history, replaces only its material/stage snapshots, and must not change reusable BOM or routing templates.

**Why:** The user chose full same-order editing only before inventory/financial side effects and specifically asked to block edits when cost-source allocations exist. After execution evidence or related records exist, replacing the snapshot could disconnect operational history from its inputs.

**How to apply:** Keep the server-side guard authoritative, even if the UI hides the edit action. Corrections after the safe window need a separate reversal/reconciliation flow.
