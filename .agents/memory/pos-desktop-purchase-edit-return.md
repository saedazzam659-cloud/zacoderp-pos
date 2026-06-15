---
name: POS Desktop purchase invoice edit + return warehouse
description: Edit/duplicate semantics for back-office purchase invoices and the source-warehouse rule for purchase returns.
---

# Purchase invoice edit/duplicate works in BASE currency only

When re-opening a persisted purchase invoice for edit/duplicate in `PurchasesAdmin.tsx`,
`seedFromPurchase` reuses the persisted **base-currency** `unitCost` with `disc=0`,
and does NOT reconstruct the original FX rate or per-line/header discount breakdown.

**Why:** purchase lines are stored already net (discount baked in) and converted to base
currency; the discount overlay only keeps aggregate gross/discount totals, not per-line
disc values, so a faithful reconstruction is impossible. Working in base on edit keeps
the net amounts (and therefore the JE + stock cost) exactly correct; re-saving rebakes
from the net values so there is no double-discount.

**How to apply:** on save in edit mode, `clearDocDiscount("purchase", id)` then
`saveDocDiscount(...)` to avoid a stale overlay. If FX-on-edit parity is ever required,
seed currency/rate from the overlay — otherwise label edit as base-currency-only.
Invoice number is immutable on edit (Rust `purchase_update` keeps the original `invoice_no`).

# Purchase return prefill must default to the SOURCE purchase warehouse

`startReturn(id)` must seed the return prefill with `warehouseId: inv.warehouseId ?? null`,
NOT a hard-coded `null`.

**Why:** `purchases_local.warehouse_id` (and `purchase_lines_local.warehouse_id`) ARE
persisted (Rust resolves to the company default at create time, so it is always non-null),
and return posting drives stock-out from the header warehouse. Hard-coding `null` makes
the return fall back to the company default warehouse, which can unwind stock from a
different warehouse than the goods were received into — corrupting per-warehouse on-hand
and cost layers.

**How to apply:** whenever a return/credit doc is prefilled from a source doc that
persists a warehouse, copy the source warehouse forward; only fall back to default when
the source genuinely has none.
