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
- **Features**: Company management, customer management, invoices (standard/simplified), QR code generation (TLV Annex B), ZATCA compliance, monthly stats dashboard
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

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Important Notes
- `lib/api-zod/src/index.ts` must only re-export from `./generated/api` (not `./generated/types`) to avoid duplicate export conflicts with the split mode codegen output.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
