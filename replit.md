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
- **Features**: Company management, customer management, invoices (standard/simplified), QR code generation, ZATCA compliance, monthly stats dashboard

### api-server
- **Path**: `artifacts/api-server/`
- **Preview**: `/api`
- **Routes**: /companies, /customers, /invoices, /dashboard/summary|recent-invoices|monthly-stats

## Database Schema
- `companies` — ZATCA company settings (VAT number, CR, serials, CSID/PCSID)
- `customers` — Customer records linked to companies
- `invoices` — E-invoices with QR code, hash, ZATCA status
- `invoice_line_items` — Invoice line items with VAT calculation

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Important Notes
- `lib/api-zod/src/index.ts` must only re-export from `./generated/api` (not `./generated/types`) to avoid duplicate export conflicts with the split mode codegen output.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
