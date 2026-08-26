---
name: Sales invoice stock overdraft
description: Authorization and stock-policy invariants for allowing a sales invoice to take inventory negative.
---

A sales invoice may take stock below zero through either the warehouse's standing negative-stock policy or an invoice-specific override. The override requires the acting user's dedicated permission and must never mutate the warehouse policy. A configured warehouse limit still caps the projected negative balance.

**Why:** Warehouse policy is the default for routine selling, while an authorized invoice override handles exceptional sales without silently changing the global warehouse setting. A UI-only checkbox can still be forged or carried into posting by a different user.

**How to apply:** Persist the invoice choice, check permission on create/edit and again on posting, then evaluate projected stock under the same row-locking transaction used for stock deduction. Render one shared control in every supported invoice-form layout: `view` controls visibility and `edit` controls activation, while admin/superadmin bypass both. Merge the client permission map with a backend-authoritative capability probe, but never trust the client to authorize the opt-in.