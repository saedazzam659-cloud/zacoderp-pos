# ZATCA e-invoicing System

This application provides a comprehensive Saudi ZATCA e-invoicing system to optimize financial operations, automate accounting, and ensure ZATCA compliance for multi-company businesses.

## Run & Operate

_Populate as you build_

## Stack

- **Frameworks**: React, Express.js
- **Runtime**: Node.js (TypeScript)
- **ORM**: Drizzle ORM
- **Validation**: Zod, `drizzle-zod`
- **Build Tool**: Vite
- **Styling**: TailwindCSS

## Where things live

- `src/`: Monorepo packages for `api-server`, `frontend`, etc.
- `lib/db/src/schema/`: Database schema definitions (Drizzle ORM).
- `artifacts/zatca-invoicing/src/pages/`: Frontend pages.
- `api-server/src/routes/`: API endpoint definitions.
- `api-server/src/lib/sessionEvents.ts`: Realtime session event emitter.

## Architecture decisions

- **Modular Monorepo**: Uses pnpm workspaces for code reusability and clear separation of concerns, housing both frontend and backend services.
- **Multi-Tenancy**: Database schema and API design inherently support multi-company operations with `company_id` for data isolation and granular RBAC.
- **ZATCA Compliance**: Deep integration for ZATCA e-invoicing, including CSR/CSID management, UBL 2.1 XML generation, and TLV QR codes.
- **Strategic AI Integration**: AI is used for advanced analytics (e.g., sales reports, cost center analysis), content generation (e.g., product descriptions), and operational assistance with rule-based fallbacks.
- **Realtime Session Synchronization**: Utilizes Server-Sent Events (SSE) for immediate propagation of critical SuperAdmin changes (e.g., subscription, company state) to logged-in users, enhancing responsiveness.

## Product

- ZATCA e-invoicing (CSR, CSID, UBL 2.1 XML, TLV QR codes)
- Multi-company support with bilingual (Arabic/English) RTL interfaces
- Inventory Management (warehouses, stock, multi-unit, costing)
- Accounting (Fiscal Periods, Account Statements, Financial Transactions, Vouchers, Cost Centers)
- Sales & Purchasing (Quotation to Invoice Linking, Sales Documents, POS, LC Expense Management)
- User & Access Management (RBAC, Audit Log, Self-Registration, SuperAdmin multi-layer login)
- AI-powered features (Voice/AI Screen Actions, Production Assistant, Security Analysis, Reporting, SEO, Tax Entry)
- Customizable invoice templates, logo uploads, per-company decimal settings
- Online Store module with product management, order processing, and AI analytics

## User preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

## Gotchas

- **Branch-Level Data Isolation**: For users with `view_all_branches=false`, data is scoped to assigned branches across `/api/org/branches`, `/api/cash-boxes`, `/api/bank-accounts`, and `/api/inventory/warehouses`. Shared rows (NULL `branch_id`) are read-only for restricted users.
- **Posted Invoice Lock**: Sales and purchase invoice edit screens become read-only (`<fieldset disabled>`) when `existing.status === "posted"`. Modifications require unposting via specific API endpoints.
- **LC Expense Currency Default**: When adding an expense to an LC, if the LC currency is not the company's base currency, the `currencyCode` for the new expense defaults to the **base currency (SAR) with rate=1**. Server-side guards enforce `exchangeRate=1` for base currency entries.

## Pointers

- **Skills**: `pnpm-workspace`, `react-query`, `drizzle-orm`, `express`, `zod`, `tailwind`, `typescript`, `ai-integration`
- **External Docs**:
    - [ZATCA E-invoicing Regulations](https://zatca.gov.sa)
    - [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
    - [Zod Documentation](https://zod.dev/)
    - [React Query Documentation](https://tanstack.com/query/latest)
    - [OpenAI API Documentation](https://platform.openai.com/docs/overview)