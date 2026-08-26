---
name: Sales invoice stock overdraft
description: Authorization and stock-policy invariants for allowing a sales invoice to take inventory negative.
---

A sales invoice may take stock below zero only when all three conditions hold: the invoice explicitly opts in, the acting user has the dedicated permission, and every affected warehouse allows negative stock. A configured warehouse limit caps the projected negative balance.

**Why:** A warehouse-wide flag alone silently lets every invoice oversell, while a UI-only checkbox can be forged or carried into posting by a different user.

**How to apply:** Persist the invoice choice, check permission on create/edit and again on posting, then evaluate projected stock under the same row-locking transaction used for stock deduction. Render one shared control in every supported invoice-form layout: `view` controls visibility and `edit` controls activation, while admin/superadmin bypass both. Merge the client permission map with a backend-authoritative capability probe, but never trust the client to authorize the opt-in.