---
name: POS Desktop Brand Management (العلامة التجارية)
description: How optional multi-brand support is stored/wired in the offline Windows POS and why brand is print-only + LS-overlay.
---

Optional, additive multi-brand feature for `artifacts/pos-desktop`: one item → many brands, each brand carries its own price/cost/barcode/part-number (avoids duplicating items). An item with no brands behaves exactly as before.

**Storage is PURE localStorage, LOCAL-ONLY (no cloud sync, no Rust/SQLite column).** Three LS keys under `pos_desktop_*` (cleared by the standalone mode-switch wipe):
- brand master list, per-item brand links (keyed by item id), and a per-invoice print snapshot.
- **Why:** mirrors the item-meta / discount overlay reasoning — local-only catalog fields ride an LS overlay instead of new SQLite columns + CI-only Rust commands.

**Brand is PRINT-ONLY.** At entry a picked brand only (a) loads the brand's own sale price into the existing line `unitPrice`, and (b) snapshots the brand NAME for the printed invoice. It NEVER enters the ZATCA UBL XML / hash / signature / QR / ICV-PIH.

**Back-office sales-invoice picker (SalesInvoicesAdmin.tsx only — NOT cashier RegisterScreen/SalesScreen):**
- Back-office lines round-trip through Rust `sales_invoice_create`/`_get`, which has NO brand column. So the picked brand name is snapshotted into an LS overlay keyed by invoice id, **indexed in persisted (cleaned) line order** — the same order `getSalesInvoice` returns (Rust inserts in input order, reads `ORDER BY sl.id`). Print merges the snapshot back by index. Mirrors the `discount.ts` overlay pattern.
- **How to apply / gotcha:** the snapshot invariant is "aligned to the PERSISTED lines". On the ZATCA-bridge retry path (`savedId != null`) the invoice is NOT re-created, so do NOT re-save the brand snapshot there — the first-create snapshot already matches the persisted lines; re-saving from a reordered form would misalign. This exactly matches the existing `saveDocDiscount` retry semantics (retry = bridge-only, no persisted edits). Overlay saved on create + edit, dropped on delete.

Master screen is BrandsAdmin (view/nav/permission/PosShell render-branch + moduleRegistry wired); item↔brand links edited in ItemsAdmin.
