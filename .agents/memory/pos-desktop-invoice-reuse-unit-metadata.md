---
name: POS Desktop invoice reuse unit/weighed metadata
description: Why OfflineInvoicePayload lines must carry optional unit/weighed fields for faithful "استخدام" (reuse) of an offline invoice into a new cart.
---

# Reuse must reconstruct multi-unit / weighed cart lines

The "استخدام" feature rebuilds a NEW cart from a persisted `offline_invoices` row
(reuse the PERSISTED payload, never mutate the signed invoice). The payload line
originally carried only `{itemId,nameAr,qty,unitPrice,vatRate}`. That is lossy:

- A non-base **unit** sale (e.g. كرتونة, factor 12) is stored as `qty=1,
  unitPrice=cartonPrice` with the unit only encoded as a `(كرتونة)` suffix inside
  `nameAr`. Money total is right, but rebuilding it as a plain base-unit line
  deducts **1 piece instead of 12** at the next checkout → wrong stock.
- A **weighed** line (`type=date`-style kg sale) similarly only had `(X كجم)` in
  the name.

**Fix (the rule):** `OfflineInvoicePayload.lines` carries OPTIONAL
`unitId/unitName/unitFactor/weighed`. These are additive — the Rust side stores
`payload_json` as opaque TEXT and never parses line internals, so this is NOT a
SQL/Rust schema change and is fully backward-compatible. Old invoices simply lack
the fields → reuse falls back to a base-unit line.

**How to apply:**
- Every checkout payload-build site (SalesScreen AND RegisterScreen) must spread
  `unit`/`weighed` into the line when present.
- Reuse mapping hydrates `unit`/`weighed` back from those fields.
- Only strip the trailing `(...)` suffix from `nameAr` when the metadata confirms
  one was appended (`unitName != null` / `weighed === true`) — never blindly, or
  you corrupt legitimate parentheses in a base item name.
- **Why:** keeps stock deduction (qty×factor in base unit) correct on the reused
  sale; see also `pos-desktop-add-to-cart-gates.md`.
