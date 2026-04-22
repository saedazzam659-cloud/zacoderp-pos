# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + TailwindCSS + React Query

## Artifacts

### zatca-invoicing (نظام الفاتورة الإلكترونية السعودية)
- **Path**: `artifacts/zatca-invoicing/`
- **Preview**: `/` (root)
- **Purpose**: Saudi ZATCA e-invoicing system — multi-company, Arabic/English RTL UI
- **Features**: Company management, customer management, invoices (standard/simplified), QR code generation (TLV Annex B), ZATCA compliance, monthly stats dashboard, inventory module, accounting (journal entries, chart of accounts, currencies), accounting reports (trial balance, balance sheet, income statement, account statement), **Purchasing & Suppliers module** (supplier groups, letters of credit + LC expenses, purchase invoices with LC expense distribution, purchase returns, supplier settlements), **Sales module with auto journal entries on posting** (Dr Customer/Cash, Dr Discount-Allowed, Dr COGS / Cr Sales Revenue, Cr VAT Output, Cr Inventory — reversed for sales returns; auto-generated JEs are locked from manual edits and can be unposted فك الترحيل to delete the JE and reverse stock movements)
- **ZATCA Integration**:
  - CSR generation: ECDSA secp256k1 via openssl, ZATCA-specific OIDs (2.16.840.1.114028.10.1.11-15)
  - Compliance API: POST /api/companies/:id/compliance (OTP → CSID)
  - Production CSID: POST /api/companies/:id/production-csid (PCSID onboarding)
  - Invoice submission: POST /api/invoices/:id/submit (clearance B2B / reporting B2C)
  - QR Code: TLV binary encoding (Tags 1-5) stored as base64, rendered via qrcode.react
  - XML: UBL 2.1 full ZATCA namespace, invoice hash chaining (SHA-256), counter tracking
  - Sandbox URL: gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal
  - Production URL: gw-fatoora.zatca.gov.sa/e-invoicing/core

### api-server
- **Path**: `artifacts/api-server/`
- **Preview**: `/api`
- **Routes**: /auth, /companies, /customers, /suppliers, /invoices, /dashboard/summary|recent-invoices|monthly-stats, /inventory/*, /accounts (CRUD)

## Auth System
- JWT-style Bearer tokens stored in localStorage
- Single-session enforcement: login regenerates sessionToken (invalidates old sessions)
- Frontend polls /api/auth/me every 10s — logs out if session changed elsewhere; also updates menuPermissions in real-time
- Routes: POST /api/auth/login, POST /api/auth/register, POST /api/auth/logout, GET /api/auth/me
- Password hashing: bcryptjs (12 rounds)
- Register flow creates: company + subscription + admin user atomically

## Subscription Plans
- Starter: 1 user, 50 invoices/mo, 99 SAR/mo (990 SAR/yr)
- Professional: 5 users, 500 invoices/mo, 299 SAR/mo (2990 SAR/yr)
- Enterprise: unlimited users + invoices, 899 SAR/mo (8990 SAR/yr)

## Database Schema
- `companies` — ZATCA company settings (VAT number, CR, serials, CSID/PCSID, menuPermissions JSON)
- `customers` — Customer records linked to companies (+accountId FK)
- `invoices` — E-invoices with QR code, hash, ZATCA status
- `invoice_line_items` — Invoice line items with VAT calculation
- `users` — Auth users (username, passwordHash, sessionToken, sessionId, companyId, role)
- `subscriptions` — Company subscription plan, dates, limits
- `suppliers` — Supplier/vendor records linked to companies (+accountId FK)
- `accounts` — Chart of accounts (code, nameAr, nameEn, accountType enum, parentId self-ref, level, isPosting, isActive, notes)
- `inventory_items` — (+costAccountId, revenueAccountId FKs)
- `item_groups` — (+costAccountId, revenueAccountId FKs)
- `warehouses` — (+accountId FK)

## General Settings (Company)
- Route: `/general-settings` (company users only)
- Nav: القائمة الجانبية → النظام → الإعدادات العامة (Sliders icon)
- Features: logo upload (drag & drop, base64, max 2MB), decimal places (0-4)
- API: PATCH `/api/companies/:id/general-settings` with `{ logo?, decimalPlaces? }`
- DB columns: `companies.logo` (text, base64), `companies.decimalPlaces` (integer, default 2)
- Logo and decimalPlaces are passed to print templates automatically

## Invoice Print Templates (5 designs)
- Triggered by "طباعة" button on issued invoices
- Component: `src/components/InvoicePrintDialog.tsx`
- Template selector dialog shows 5 thumbnail previews
- On confirm: generates full HTML → opens new window → triggers window.print()
- QR code generated from base64 TLV using `qrcode` package (toDataURL)
- Templates: كلاسيكي (black borders), عصري (gray minimal), احترافي (teal header),
  ملوّن (blue-indigo gradient), مدمج (side-by-side with large QR)
- All templates: RTL Arabic, company logo, line items table, totals, decimal places respected

## Menu Permissions System
- Superadmin can toggle per-company menu visibility from `/admin/menu-permissions`
- Permissions stored as JSON in `companies.menuPermissions` column
- Keys: `dashboard`, `invoices`, `customers`, `suppliers`, `zatca` (all default true)
- API: PATCH `/api/companies/:id/menu-permissions` with `{ menuPermissions: JSON string }`
- Changes apply instantly — Layout.tsx reads permissions from auth context and filters nav items
- Page shows toggle-matrix table, one row per company, one column per menu item
- Success/error toast shown after each toggle save
- HTTP caching disabled on API server (no ETags, Cache-Control: no-store) to prevent stale responses after PATCH

## Inventory Management Module
- Routes: `/inventory/*` (company users only)
- Nav section: "المخازن والمخزون" in sidebar (8 links)
- DB Tables (lib/db/src/schema/inventory.ts): warehouse_groups, warehouses, item_groups, units, items, **item_unit_prices**, stock_balance, stock_ledger, stock_transfers + stock_transfer_items, stock_adjustments + stock_adjustment_items, stock_counts + stock_count_items (14 tables total)
- API routes: `/api/inventory/*` in `artifacts/api-server/src/routes/inventory.ts`
- Frontend API client: `artifacts/zatca-invoicing/src/lib/inventoryApi.ts` (uses `zatca_token` from localStorage)
- Cost method: Weighted Average (متوسط مرجح) — auto-computed on stock-in, unchanged on stock-out

### Multi-Unit Per Item (item_unit_prices table)
- Each item can have multiple units with different conversion factors and prices
- Example: Item "سكر" — واحدة (×1, cost 5, sale 10) + كرتونة (×12, cost 60, sale 100)
- `item_unit_prices` columns: companyId, itemId, unitId, conversionFactor, costPrice, salePrice, isBase
- API: GET/POST/PUT/DELETE `/api/inventory/items/:id/units` + GET `/api/inventory/items/:id/units/:unitId`
- In Items.tsx expanded row, "وحدات التسعير" tab lets user add/edit/delete unit-price rows per item
- In StockTransfer/StockAdjustment: selecting item fetches its unit prices, auto-selects base unit + fills cost; changing unit auto-fills cost from item_unit_prices; shows conversion hint (e.g., "×12 → 24 وحدة أساسية")
- Global units page (`Units.tsx`) now has preset quick-add buttons and concept explanation

### Pages (artifacts/zatca-invoicing/src/pages/inventory/):
  - `InventoryDashboard.tsx` — KPI cards + quick actions + recent movements
  - `Warehouses.tsx` — CRUD with group, city, allow-negative-stock toggle
  - `WarehouseGroups.tsx` — CRUD
  - `Items.tsx` — CRUD + expandable row with 2 tabs: (1) أرصدة المخازن, (2) وحدات التسعير (multi-unit management)
  - `ItemGroups.tsx` — CRUD
  - `Units.tsx` — CRUD with quick-presets (PCS, CTN, KG...) + concept explanation panel
  - `StockTransfer.tsx` — Draft/post workflow; smart unit selection auto-fills cost from item_unit_prices
  - `StockAdjustment.tsx` — +/- qty adjustments with reason + smart unit auto-fill
  - `StockCounting.tsx` — Auto-loads system balances, enter actual qty, approve → post diffs
  - `StockLedger.tsx` — Full movement history with filters (date range, item, warehouse)
  - `StockBalance.tsx` — Current balance per item×warehouse with alert for below-reorder items

## Fiscal Periods Module
- Routes: `/accounting/fiscal-periods` (company users only)
- Nav: المحاسبة → الفترات المالية (CalendarRange icon)
- DB tables (lib/db/src/schema/fiscalPeriods.ts):
  - `fiscal_years` (id, companyId, name, startDate, endDate, status)
  - `fiscal_periods` (id, companyId, fiscalYearId, name, startDate, endDate, status, sequence)
  - Status enum: open / closed / permanently_closed (permanently_closed is immutable)
- API (`/api/fiscal/*` in fiscal-periods.ts):
  - GET /years, GET /years/:id, POST /years (auto-splits into Arabic monthly periods)
  - DELETE /years/:id (blocked if any period closed)
  - PATCH /periods/:id/status, PATCH /years/:id/status (cascades, skips permanent)
- Auto-split: timezone-agnostic UTC math; handles full years, partial months, mid-month, leap years, cross-year ranges
- Strict ISO date validation (rejects calendar-invalid like 2026-02-31)
- Overlap detection uses string compare on ISO dates (TZ-safe)
- Frontend: master-detail layout (year sidebar + year header with stats + 3-col monthly period grid with status badges and per-period actions); inline new-year form with live period count

## Tax-Inclusive Pricing on Sales Documents
- New column `priceIncludesVat` (boolean, default false) on `sales_invoices` and `sales_quotations`
- Toggle "السعر شامل الضريبة" appears in the "الأصناف" tab footer of the sales invoice/quotation form (`SalesDocumentForm.tsx`)
- When ON: stored unitPrice contains VAT. Form derives Net = gross/(1+rate), VAT = gross-Net, lineTotal = gross
- When OFF (default): unitPrice is VAT-exclusive, VAT added on top (legacy behavior)
- Toggling instantly recomputes every line total
- Totals card shows Net (الصافي) / VAT (الضريبة) / Total (الإجمالي) breakdown with mode badge
- API: POST/PUT /sales-invoices and /sales-quotations accept `priceIncludesVat` (parsed strictly via `asBool()`)
- Quotation→invoice conversion (`POST /sales-quotations/:id/convert`) propagates the flag to the new invoice
- Posting/JE generation unchanged — uses stored `subtotal` and `vatAmount` directly

## Document-Level Discount (Shared across Sales + Purchasing)
- Shared component: `artifacts/zatca-invoicing/src/components/DiscountRow.tsx` — two synced inputs (% and SAR amount). Editing % auto-derives amount from gross; editing amount auto-derives %. Both clamped: % ∈ [0,100], amount ∈ [0, gross]. testids: `doc-discount-pct-input`, `doc-discount-input`.
- Wired into 4 forms (placed under VAT in totals card):
  - `SalesDocumentForm.tsx` (sales invoices + quotations)
  - `PurchaseInvoiceForm.tsx`
  - `SalesReturns.tsx`
  - `PurchaseReturns.tsx` — also removed the legacy standalone "خصم مكتسب" Field from form grid
- Math everywhere: gross = sum(lineTotal incl. VAT) → docDiscountAmt = clamp(form.discountAmount, [0, gross]) → total = gross − docDiscountAmt
- Per-line "خصم%" (sales invoices/quotations + purchase invoices) is also shown as a read-only red row "خصم الأصناف" in the totals card (data-testid `line-discount-total`), computed as Σ(noDiscountLineTotal − withDiscountLineTotal). Hidden when 0. Sales returns and purchase returns have no per-line discount.
- Server-side hardening:
  - `clampDiscountAndTotal()` in `sales.ts` for sales invoices/quotations (POST/PUT)
  - `sales-returns` POST/PUT in `sales.ts` recompute total from clamped discount + line gross
  - `salesReturnsTable` schema: added `discountAmount` numeric(15,2) NOT NULL DEFAULT '0'; `editReturn()` loads it back for round-trip
  - Purchase invoices/returns: schema already had `discountAmount`; JE generation uses it; server-side clamp on these endpoints is a TODO
- JE balance preserved on posting: party debit = total (gross−discount), discount account debit = discountAmount, credit sales/inventory = subtotal, credit VAT = vatAmount → balanced
- Posting requirement: blocks with Arabic error if discount > 0 and no `discountAccountId` set

## Stock Transfer — Auto Journal Entry + AI Account Suggestion
- Schema (`stock_transfers`): added `from_account_id`, `to_account_id`, `journal_entry_id` (legacy `account_id` retained).
- Backend `POST /api/inventory/stock-transfers/:id/post`:
  - Atomic claim (UPDATE … WHERE status='draft') prevents double-post.
  - Auto-creates balanced JE: DR `to_account` / CR `from_account`, total = Σ(qty × costPrice). Skips if accounts equal/missing or total = 0.
  - Falls back to `warehouses.account_id` when transfer-level overrides are not set.
- Multi-tenant guard: `assertCompanyOwned()` validates warehouse + account IDs against `companyId` on create/update.
- AI endpoint `POST /api/ai/suggest-transfer-accounts`: picks the best inventory accounts from the company's chart of accounts (asset+posting only). Graceful rule-based fallback when AI unavailable or any runtime exception.
- Frontend (`StockTransfer.tsx`): two `AccountCombobox` (filtered to assets), an "اقتراح بالذكاء الاصطناعي" button, and a live JE preview that mirrors backend behavior (including warehouse-account fallback indicator).

## Stock Adjustment — Auto Journal Entry + AI Account Suggestion
- Schema (`stock_adjustments`): added `inventory_account_id`, `adjustment_account_id`, `journal_entry_id` (legacy `account_id` retained).
- Backend `POST /api/inventory/stock-adjustments/:id/post`:
  - Atomic claim (UPDATE … WHERE status='draft') prevents double-post.
  - Computes net direction from items: net increase → DR inventory / CR adjustment (gain); net decrease → DR adjustment / CR inventory (loss).
  - Total per side = Σ(|qty| × costPrice), netted across lines so a balanced 2-line JE is created.
  - Falls back to `warehouses.account_id` when `inventory_account_id` is not set. Skips JE when accounts equal/missing or amount = 0.
- Multi-tenant guard: `assertCompanyOwned()` validates warehouse + account IDs against `companyId` on create/update.
- AI endpoint `POST /api/ai/suggest-adjustment-accounts`: classifies reason + items as increase/decrease, picks an asset account for inventory and either an expense (loss) or revenue (gain) account for the contra side. Note: PG enum is `revenue` (income alias also accepted). Graceful rule-based fallback for missing AI/empty pool/runtime errors.
- Frontend (`StockAdjustment.tsx`):
  - Two-tab layout: "معلومات التسوية والقيد المحاسبي" + "الأصناف" (with item count badge).
  - Two `AccountCombobox` (asset / expense+revenue), AI suggestion button, live JE preview that detects net direction and shows DR/CR with warehouse-account fallback indicator.

## License Management Module
- Route: `/admin/licenses` (superadmin only)
- DB cols on subscriptions: maxBranches, maxWarehouses (in addition to maxUsers/maxInvoices)
- API: POST /api/admin/licenses (upsert), with strict ISO/int validation

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Important Notes
- `lib/api-zod/src/index.ts` must only re-export from `./generated/api` (not `./generated/types`) to avoid duplicate export conflicts with the split mode codegen output.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
