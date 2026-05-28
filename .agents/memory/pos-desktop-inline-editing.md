---
name: POS Desktop inline-editing pattern
description: Convention for admin pages in artifacts/pos-desktop — modals are forbidden; CRUD happens inline in the data grid.
---

All admin pages under `artifacts/pos-desktop/src/pages/` use inline editing instead of modal dialogs. There are three sub-patterns:

1. **Simple master-data (warehouses/suppliers/banks/customers/uom/accounts/cash-boxes/users)** — clicking "+ إضافة" inserts a green `<tr style="background:#f0fdf4">` at the top of the tbody with inputs in the same columns as data; clicking "تعديل" on a row turns it blue (`#eff6ff`) with inputs in place. While editing, all other rows are at `opacity:0.6` and their action buttons are disabled. Save/Cancel live in the actions column.

2. **Create-only with sub-lines (financial tx, stock adjustments, stock transfers, stocktakes)** — no row edit; clicking "+ جديد" reveals a bordered `<Card>` panel ABOVE the table (border colour matches operation: blue/green/red) containing the full form including the lines mini-table. The "+ جديد" button is disabled while the panel is open.

3. **Create + read-only view with sub-lines (purchase invoices, purchase returns, journal entries)** — create uses the panel-above-table pattern (#2). The "عرض" button toggles a `<tr><td colSpan=N>` expanded detail row directly below the parent row, with the line-items table inside.

**Why:** the original Windows POS used `<Modal>` overlays everywhere; the user found focus-loss and click-to-dismiss disruptive on touch hardware. Inline keeps the operator's eye in the same vertical band as the row they were working on.

**How to apply:**
- Never re-introduce a modal under `artifacts/pos-desktop/src/pages/`. The `Modal` component exported from `_adminUi.tsx` is kept only for non-admin flows; do not import it here.
- Workflow modals (CSV/EDA import in `ItemsAdmin.tsx`) are the only exception — they are file-pickers with progress UI, not CRUD.
- For pattern #1, reuse the inline cell-input style: `const ci = { ...input, padding: "6px 8px", fontSize: 13 }`.
- When the edit form is too tall for a single row (10+ fields, like ItemForm with pharmacy + scale sections), fall back to pattern #2/#3 with a bordered panel above the table — but still no overlay.
- `EditState` discriminated unions should use `T["id"]` (e.g. `LocalUser["id"]`) rather than hard-coded `number` — `LocalUser.id` and `Uom.id` are `string`.
