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

## Phase 2 additions (Aug 2026)
- **Mobile sequence series**: `sales_invoice_mobile` + `receipt_voucher_mobile` in SEQUENCE_TX_TYPES; api-server draws them FIRST when header `x-app-channel: mobile` is present (mobile lib/api.ts sends it on every request), falling back to the normal payment/foreign split. ICV/PIH chain untouched.
- **Print/share**: `lib/print.ts` ports web template-14 (tafqeet, lineFigures/tax-mode math, phase-1 TLV QR). No `btoa` — own base64+UTF8 encoders (Hermes-safe); QR via `qrcode` `toString(...,{type:'svg'})` (pure JS). expo-print/expo-sharing; web fallback opens the PDF URL.
- **Reports screens**: `app/report/[kind].tsx` (trial-balance / balance-sheet / income-statement / vat). VAT response nests values at `outputTax.total.vat` / `inputTax.total.vat` (NOT flat). Balance-sheet credit-nature balances arrive NEGATIVE — render Math.abs like the web report.
- **Security fix found here**: `/api/accounting-reports/*` and `/api/reports/vat-declaration*` only required auth — now router-gated with `requirePermission("accounting_reports"|"vat_declaration","view")`. Any new mobile screen hitting an "internal" report route must verify the route enforces its module perm server-side, not just UI card hiding.

## Source-channel column (المصدر)
- `source_channel` nullable text on sales_invoices/sales_returns/receipt_vouchers; set to 'mobile' at CREATE only when `x-app-channel: mobile` header present; never touched by edit/post/unpost (narrow patches preserve it); conversions leave it null (= web).
- Web label derivation: invoices جوال if sourceChannel==='mobile', else POS if posSessionId, else ويب; returns/vouchers جوال/ويب only.
- Grid wiring gotcha: SalesAuditGrid CSV + buildExportColumns/Rows/Totals are hard-coded separately from COLUMNS — new columns must be added there too; SalesReturns CSV derives from COLUMNS but its Excel/PDF builders are hard-coded.
- lib/db emits declaration-only dist; after schema edits run `pnpm exec tsc -b lib/db` from root or api-server tsc sees stale types (TS2769 on inserts).
