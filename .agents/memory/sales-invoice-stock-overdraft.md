---
name: Sales invoice stock overdraft
description: Authorization and stock-policy invariants for allowing a sales invoice to take inventory negative.
---

A sales invoice may take stock below zero only when all three conditions hold: the invoice explicitly opts in, the acting user has the dedicated permission, and every affected warehouse allows negative stock. A configured warehouse limit caps the projected negative balance.

**Why:** A warehouse-wide flag alone silently lets every invoice oversell, while a UI-only checkbox can be forged or carried into posting by a different user.

**How to apply:** Persist the invoice choice, check permission on create/edit and again on posting, then evaluate projected stock under the same row-locking transaction used for stock deduction. Keep the invoice control visible for discoverability, but enable it only when the backend-authoritative edit capability allows it; never trust a client permission map to authorize the opt-in.