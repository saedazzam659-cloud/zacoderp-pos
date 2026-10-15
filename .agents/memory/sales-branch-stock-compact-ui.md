---
name: Compact sales branch stock
description: UI constraint for branch availability inside sales invoice item pickers.
---

Show permitted branch quantities through a compact in-field affordance and popover. Do not widen, shrink, or add vertical content to the invoice item field or its row.

**Why:** The previous inline branch-stock chips expanded the item row and damaged the invoice grid layout; the user explicitly asked to keep the field and row dimensions unchanged.

**How to apply:** When adding branch-stock information to sales invoices or quotations, place the trigger in the item picker's existing icon gutter and render quantities in an overlay/popover.
