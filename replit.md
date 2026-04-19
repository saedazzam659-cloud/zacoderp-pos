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
- **Routes**: /auth, /companies, /customers, /suppliers, /invoices, /dashboard/summary|recent-invoices|monthly-stats

## Auth System
- JWT-style Bearer tokens stored in localStorage
- Single-session enforcement: login regenerates sessionToken (invalidates old sessions)
- Frontend polls /api/auth/me every 30s — logs out if session changed elsewhere
- Routes: POST /api/auth/login, POST /api/auth/register, POST /api/auth/logout, GET /api/auth/me
- Password hashing: bcryptjs (12 rounds)
- Register flow creates: company + subscription + admin user atomically

## Subscription Plans
- Starter: 1 user, 50 invoices/mo, 99 SAR/mo (990 SAR/yr)
- Professional: 5 users, 500 invoices/mo, 299 SAR/mo (2990 SAR/yr)
- Enterprise: unlimited users + invoices, 899 SAR/mo (8990 SAR/yr)

## Database Schema
- `companies` — ZATCA company settings (VAT number, CR, serials, CSID/PCSID, menuPermissions JSON)
- `customers` — Customer records linked to companies
- `invoices` — E-invoices with QR code, hash, ZATCA status
- `invoice_line_items` — Invoice line items with VAT calculation
- `users` — Auth users (username, passwordHash, sessionToken, sessionId, companyId, role)
- `subscriptions` — Company subscription plan, dates, limits
- `suppliers` — Supplier/vendor records linked to companies

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

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Important Notes
- `lib/api-zod/src/index.ts` must only re-export from `./generated/api` (not `./generated/types`) to avoid duplicate export conflicts with the split mode codegen output.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
