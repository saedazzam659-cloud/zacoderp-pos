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
- **SAP-style Production WIP Cycle**: Production orders post a full DR WIP / CR Raw inventory journal entry on `in_production` (with header‑level labor + overhead allocation), and DR Finished Goods (+ DR Variance/Waste) / CR WIP on `completed`. Finished‑goods unit cost is `wipBalance × producedQty / (producedQty + wasteQty)`. Cancelling an issued order auto‑reverses the issue. Header `costCenter` propagates to every JE line. Warehouse + account fields lock once issue is posted.
- **Manufacturing Master Data (Phase A)**: BOM Templates (`bom_templates` + `bom_template_lines`) define standard raw materials per FG product. On production order creation, if an active template exists for the chosen `productItemId`, raw lines are auto‑copied into the order with quantities scaled by `plannedQty / template.outputQty`. Per-company defaults live in `manufacturing_settings` (raw/FG warehouses, cost center, 7 GL accounts) and are applied when matching fields are omitted from POST `/api/production/orders`. Manage via `/production/bom-templates` and `/production/settings`.

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

- **Branch-Level Data Isolation**: For users with `view_all_branches=false`, data is scoped to assigned branches across `/api/org/branches`, `/api/cash-boxes`, `/api/bank-accounts`, and `/api/inventory/warehouses`. Shared rows (NULL `branch_id`) are read-only for restricted users. **Branch filter semantics**: when an explicit `?branchId=X` is passed (or implied by user scope), `effectiveBranchCondition` matches `branch_id = X OR branch_id IS NULL` — NULL-branch rows are company-wide/shared (opening JEs, system-generated entries, shared resources) and must remain visible from any branch context. Otherwise picking the only branch in a single-branch company would yield different totals than "all branches" because NULL rows would be silently excluded.
- **Posted Invoice Lock**: Sales and purchase invoice edit screens become read-only (`<fieldset disabled>`) when `existing.status === "posted"`. Modifications require unposting via specific API endpoints.
- **LC Expense Currency Default**: When adding an expense to an LC, if the LC currency is not the company's base currency, the `currencyCode` for the new expense defaults to the **base currency (SAR) with rate=1**. Server-side guards enforce `exchangeRate=1` for base currency entries.
- **Posted-Only Financial Reports**: Trial Balance, Balance Sheet, Income Statement, and Account Statement (`/api/reports/trial-balance`, `/balance-sheet`, `/income-statement`, `/account-statement`) include only journal entries with `status = 'posted'`. Draft (unposted) entries are work-in-progress and have **zero** impact on any financial report — opening, period, closing, running balance, and previous balance all ignore them. Unposting an entry (`POST /api/journal-entries/:id/unpost` flipping status `posted → draft`) instantly removes its impact from every report on the next refresh. System-generated JEs (sales/purchase invoices, vouchers, POS, payroll, production, stock movements) are inserted as `posted` directly, so this filter only affects manually-created draft JEs and entries explicitly unposted via the API.
- **Period Closing Cycle (IFRS-aligned)**: The fiscal-period close has 5 independent steps: validate → close-pl → transfer-profit → soft-close → hard-close. **Soft-close** rejects when revenue/expense accounts still have non-zero balances (`requiresPlClose: true` in the response) unless `force=true` is passed — needed for monthly soft-closes where P&L closes only at year-end. **Hard-close** has NO `force` override — it requires both a `closing_revenue`/`closing_expense` JE AND a `closing_transfer_profit`/`closing_transfer_loss` JE to exist for the period (skipped only when there was zero P&L activity). Recovery from a prematurely hard-closed period requires `POST /api/fiscal/periods/:id/force-reopen` (SuperAdmin only, requires a `reason` ≥ 10 chars, logged via `req.log.warn`). The standard `PATCH /periods/:id/status` still refuses to touch `permanently_closed` periods.
- **Production Order Post-Issue Lock**: Once a production order moves to `in_production`, the WIP setup fields (raw warehouse, WIP/raw-inventory/labor/overhead accounts, labor & overhead amounts) become read-only via PATCH guard. Changing them after the issue JE has posted would corrupt the WIP balance because the receipt JE would credit a different WIP account than the issue debited. To change them, cancel the order (which auto-reverses the issue) and re-do the cycle. FG-side fields (FG warehouse, FG/variance/waste accounts, costCenter) remain editable until completion.

## Pointers

- **Skills**: `pnpm-workspace`, `react-query`, `drizzle-orm`, `express`, `zod`, `tailwind`, `typescript`, `ai-integration`
- **External Docs**:
    - [ZATCA E-invoicing Regulations](https://zatca.gov.sa)
    - [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
    - [Zod Documentation](https://zod.dev/)
    - [React Query Documentation](https://tanstack.com/query/latest)
    - [OpenAI API Documentation](https://platform.openai.com/docs/overview)