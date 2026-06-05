---
name: POS Desktop ZATCA bridge for back-office sales invoices
description: How ERP back-office sales invoices reach ZATCA without merging tables, and why totals must come from the persisted invoice.
---

# POS Desktop — ZATCA bridge for back-office sales invoices

Back-office sales invoices (`SalesInvoicesAdmin` → `sales_invoices_local`) historically did
NOT flow to ZATCA — only the POS register did (it builds a TLV QR + enqueues into
`offline_invoices`, which `/api/sync/push` carries to the cloud for ZATCA).

The bridge (`lib/zatcaBridge.ts`) reuses that exact register pipeline for back-office
invoices instead of building a second submission path. The two tables stay **physically
separate** (no merge): `sales_invoices_local` keeps its rich accounting JEs; the bridge
just mints the matching `offline_invoices` row and links it back via two additive columns
(`zatca_qr_base64`, `zatca_offline_uuid`) + the `sales_invoice_set_zatca` command.

## Rules / non-obvious constraints

- **Build the QR + payload from the PERSISTED invoice, not the form state.** Read totals +
  lines back via `getSalesInvoice(id)` (the authoritative Rust-computed values) and only
  round there. Recomputing `subtotal`/`vat` in the UI risks rounding/FX drift between the
  QR (tags 4/5) and what `sales_invoice_create` actually stored.
  **Why:** the QR and the stored invoice must agree or ZATCA validation/clearance can reject.
- **Idempotency key is `sinv-<invoiceId>`.** A bridge retry reuses the same `offline_invoices`
  row instead of minting duplicates. Persist the invoice first, set `savedId`, and on a
  bridge retry skip the create + discount write entirely — only re-run the bridge.
- **`zatcaQrBase64` is TLV printer data, NOT an image.** It is fed to the thermal printer's
  `qrData`. There is no on-screen QR-image renderer in the app; do not try to render it as
  an `<img>`. Show a status badge instead.
- **Gating: country == "SA", absent key defaults to "SA"** (matches `taxSettings.ts` reading
  the same `pos_desktop_country` key as `country || "SA"`, and first-run always sets it) so a
  real SA install always bridges rather than silently skipping ZATCA.
- Bridge failure is **non-fatal** — the invoice is already saved; surface an Arabic warning
  and `return` (keep form open) so حفظ can retry.
