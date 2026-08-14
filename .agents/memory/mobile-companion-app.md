---
name: Mobile companion app (Expo)
description: Contracts and traps for artifacts/mobile — the Arabic ERP companion app calling api-server directly.
---

- App = `artifacts/mobile` (Expo Router, Arabic-first, manual RTL via row-reverse/text-right; no I18nManager). Auth token in AsyncStorage via `lib/api.ts` (cleared on any 401); server domain overridable in المزيد for agent/custom-domain servers.
- **Server rules the mobile client must honor** (sales create/PUT 400 otherwise): `branchId` required (default: user.branchIds[0] → default/first from `/api/org/branches`, which is perm-gated so retry:false + fallback); customer required for every non-POS invoice (no "no customer" simplified path); stock lines need `warehouseId` (+`unitId`) — default from `/api/inventory/warehouses`.
- `invoiceType` (standard/simplified) is NOT a server field — ZATCA mapper derives it from customer VAT number. Never send or promise it client-side.
- `docNumber` omitted on create — server sequence engine mints it.
- `lineTotal` = entered gross (qty×unitPrice), matching web form, even in price-includes-VAT mode.
- Receipt vouchers POST as **drafts**; must call `POST /api/receipt-vouchers/:id/post` afterwards or nothing hits the ledger.
- Barcode scan: expo-camera modal screen + `lib/scanBus.ts` one-shot callback.
- **Why:** first architect review failed the app on exactly these contract gaps; they are invisible in tsc and only surface as prod 400s.
- **How to apply:** any new mobile document screen must replicate branch/warehouse defaulting, post-after-create for draft doc types, and defensive array guards on list endpoints.
