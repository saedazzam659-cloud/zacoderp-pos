---
name: Web POS shift-close boundary
description: Web POS shifts must not close or reopen while unfinished sales work remains.
---

For the web POS, block closing a shift or opening its replacement while the active cart, parked carts, unsynced invoices, or open restaurant orders remain unresolved. Never clear these records automatically; require the cashier to complete, sync, or explicitly cancel/delete the relevant work. Apply the rule to logout when logout closes the shift.

When a shift closes, calculate expected cash from opening cash, cash portions of posted sales (including mixed payments), and net posted cash movements. Do not ask the cashier to type a closing amount; print a report with shift details, invoices, cash movements, and the calculated total. Apply this to logout-triggered closure too.

**Why:** The user chose prevention over carrying unresolved work into a new shift or silently discarding it, to avoid losing invoices or attributing them to the wrong shift. They also requested automatic cash reconciliation and a printed record of the full shift.

**How to apply:** Keep parked carts device-local and preserve completed invoices. Count posted invoices against the active session; handle pending offline invoices before closing. Do not extend this web-only behavior to POS Desktop without an explicit request.
