---
name: Web POS shift-close boundary
description: Web POS shifts must not close or reopen while unfinished sales work remains.
---

For the web POS, block closing a shift or opening its replacement while the active cart, parked carts, unsynced invoices, or open restaurant orders remain unresolved. Never clear these records automatically; require the cashier to complete, sync, or explicitly cancel/delete the relevant work. Apply the rule to logout when logout closes the shift.

When a shift closes, calculate expected cash from opening cash, cash portions of posted sales (including mixed payments), and net posted cash movements. Require the cashier to enter counted cash, persist actual and expected amounts plus the difference, and print all three clearly in the final report. Apply this to logout-triggered closure too.

**Why:** The user requires an actual cash count after physical reconciliation, with shortages and overages visible, while also preventing unresolved work from being lost or attributed to the wrong shift.

**How to apply:** Keep parked carts device-local and preserve completed invoices. Count posted invoices against the active session; handle pending offline invoices before closing. Preserve legacy behavior when shift constraints are disabled, and do not extend web-only close behavior to POS Desktop without an explicit request.
