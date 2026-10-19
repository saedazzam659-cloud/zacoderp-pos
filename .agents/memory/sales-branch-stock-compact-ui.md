---
name: Compact sales branch stock
description: UI constraint for branch availability inside sales invoice item pickers.
---

Show the selected item's balance beside the picker using the invoice line's warehouse, falling back to the warehouse in invoice basics. Only show balances for branches the signed-in user is allowed to view. Keep the multi-branch popover and do not widen, shrink, or add vertical content to the invoice item field or its row. Permission-scoped stock queries and caches must include the user identity.

**Why:** A multi-branch popover alone does not show which quantity applies to the selected invoice warehouse. Earlier inline branch-stock chips expanded the item row and damaged the invoice grid layout, so the selected-warehouse quantity must stay compact. User-specific branch permissions also make cross-user cache reuse unsafe.

**How to apply:** For sales invoices and quotations, match the selected warehouse ID against the permitted stock response, show that quantity in the existing item-picker icon gutter, and keep the popover for other authorized branches.
