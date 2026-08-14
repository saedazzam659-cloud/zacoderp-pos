---
name: Demo-edition company seed
description: SA add-company "نسخة ديمو" seeds starter master data; gated server-side to superadmin callers.
---
`/api/auth/register` accepts `edition: "normal"|"demo"`. Demo runs `lib/seedDemoCompanyData.ts` AFTER `applyCompanyTemplateDefaults` (ledger helpers need the COA): main branch BR-0001, default warehouse WH-0001 (+ensureWarehouseAccount), unit UNT-0001 حبة, group GRP-0001, item ITM-0001, عميل نقدي (+ensureCustomerLedger), مورد محلي SUP-0001 (+ensureSupplierLedger, country/currency follow the COMPANY's selected country, never hardcode SA/SAR). Each step fail-safe, never blocks registration.

**Why gated:** /register is ALSO the public signup endpoint — `edition` is client-supplied, so the seed is honored only when `callerIsSuperAdmin`; UI visibility is not authorization.

**How to apply:** extending the demo seed = add a `step()` in seedDemoCompanyData; these are master-data rows only — they consume NO document sequences, so deleting/editing them never affects invoice/JE/voucher numbering.
