---
name: POS Desktop invoice discounts (no-Rust approach)
description: How per-line + header discounts are applied to the 4 invoice forms without touching Rust/SQLite
---

The 4 POS Desktop invoice forms (sales invoice, sales return, purchase, purchase
return) support per-line AND header (whole-doc) discounts, each as % OR value.

**Rule:** there is NO discount column in SQLite and the Rust create commands
recompute subtotal/VAT/grand-total from `qty × unitPrice|unitCost`, ignoring any
totals the frontend sends. To apply a discount without a Rust/SQLite change, the
frontend folds the discount into the **net unit price** it sends. VAT then lands
on the post-discount base — which is the ZATCA-correct behaviour anyway.

**Why:** changing the Rust layer / SQLite schema was explicitly out of scope, and
baking net unit prices keeps VAT-on-net correct for free.

**How to apply:**
- Math lives in `src/lib/discount.ts` (`lineNet`, `computeDiscount`). Header
  discount is a single proportional factor over the post-line-net amounts, so
  each line keeps its own VAT rate.
- The original pre-discount breakdown (gross subtotal + discount totals) is kept
  ONLY in a localStorage overlay keyed `${docType}:${id}` (`saveDocDiscount` /
  `getDocDiscount`, key `pos_desktop_invoice_disc_v1`) purely for re-display in
  the expanded detail row. It is best-effort and append-only (not GC'd) — if
  local data is wiped and ids are reused, stale summaries can show; acceptable.
- Shared UI: `LineDiscountCell` + `InvoiceTotals` in `_adminUi.tsx`. When adding
  a discount column to a form table, also remove the old in-table summary rows
  and mount `<InvoiceTotals/>` after the `+ سطر` button.
- Build explicit payload line objects — do NOT spread the form line (it carries
  `disc`/`discType` which would break serde on the Rust side).
