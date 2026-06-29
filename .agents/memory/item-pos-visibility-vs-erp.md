---
name: show_in_pos flag is POS-only, never ERP-wide
description: how the items "show in POS" flag must scope, and the includeHidden=1 contract on GET /api/inventory/items
---

# `show_in_pos` hides from POS apps ONLY, never from the ERP

`items.show_in_pos` (UI: "إظهار الصنف في شاشة نقاط البيع") is meant to hide an
item from the POS apps (cashier/supermarket/restaurant). It must NEVER hide the
item from the web ERP — the Items master (الأصناف), every sales/purchase
document picker, reports, and printing must still show it.

## The contract

`GET /api/inventory/items` applies `show_in_pos = true` by DEFAULT, and returns
ALL items only when the caller passes `?includeHidden=1`.

- The web POS (`artifacts/pos/src/lib/api.ts`) is the SOLE intended consumer of
  the default filter — it correctly OMITS `includeHidden`.
- Every **web ERP** (`artifacts/zatca-invoicing`) item-list fetch MUST pass
  `includeHidden=1`, or a POS-hidden item silently vanishes from the items
  master + all document forms + reports.

**Why:** the endpoint is shared between two artifacts with opposite needs. The
default was tuned for POS; the ERP must opt out on every call. This is a
recurring footgun — new ERP screens that fetch items keep forgetting it.

**How to apply:** when adding ANY item-picker/list to the web ERP, fetch via
`inventoryApi.getItems` (already sends `includeHidden=1`) or, for inline
fetches, append `includeHidden=1` to the query string. Do NOT add it to the POS
client. OnlineStore/OfferForm are a separate visibility concern — leave them.
