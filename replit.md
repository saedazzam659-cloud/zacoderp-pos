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
- **JE Explicit-Save Reservation**: The journal-entry form does NOT reserve a number on mount — opening "قيد جديد" and closing the tab leaves NO row in `journal_entries` and NO gap in the sequence. The badge above the form shows the next-estimated number via `useNextSequenceNumber` (peek-only). Clicking "حفظ" atomically consumes the number through `nextSequenceNumber(cid, "journal_entry", …)` inside `POST /api/journal-entries/`; the same endpoint accepts unbalanced / under-populated entries and persists them as `status='draft'` (balanced + ≥2 valid lines → `status='posted'`, honouring the per-company auto-post toggle via `resolvePostingStatus`). There is no `/reserve` endpoint and no `journalEntriesApi.reserve` helper — both were removed. The form has no `beforeunload`/unmount cleanup because nothing needs cleaning. Drafts created here remain valid and can be completed/posted later from مركز الترحيل; per the "Posted-Only Financial Reports" rule they have ZERO impact on reports until posted.
- **Sister Companies (الشركات الشقيقة)**: Dedicated `sister_companies` + `sister_transfers/_items` + `sister_returns/_items` + `sister_settlements` tables — NOT customers (sister cos share the user's VAT/CR so ZATCA would reject them as a customer). Module key `sister_companies`, **locked by default** (option B) — SuperAdmin must enable per company via `/admin/menu-permissions`; no parent billable module. JE per transfer post: DR COGS(cost) + DR SisterAR(supply) / CR Inventory(cost) + CR Revenue(supply); stock-ledger out. Return post reverses the exact accounts and restores stock at original cost. Settlement is bidirectional: `direction='receive'` → DR cash/bank / CR SisterAR, `direction='pay'` → DR SisterAR / CR cash/bank (entryType `sister_settlement`). No VAT (internal), SAR only, no UBL/QR/ZATCA submission. Statement report mirrors CustomerStatement with the sister-co AR account. Routes mounted at `/api/sister-companies/*`; UI under `/inventory/sister-*` (4 sidebar entries). **Express 5 / path-to-regexp 8 quirk**: `/:id`, `/:id/balance` are registered LAST in `routes/sister-companies.ts` (after `/transfers`, `/returns`, `/settlements`) — inline regex like `/:id(\d+)` is no longer supported, so registration order is the only thing that prevents `:id` from swallowing the literal sub-segments.
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

**Always confirm the route → component mapping in `App.tsx` BEFORE editing any page.** A path like `/sales/invoices` does NOT necessarily map to `SalesInvoices.tsx`. For example `/sales/invoices` is wired to `SalesAuditGrid.tsx`, not `SalesInvoices.tsx`. Run `rg -n 'path="/the/path"' artifacts/zatca-invoicing/src/App.tsx` first, identify the actual component imported there, and edit THAT file. Do not assume by filename.

## Gotchas

- **Branch-Level Data Isolation**: For users with `view_all_branches=false`, data is scoped to assigned branches across `/api/org/branches`, `/api/cash-boxes`, `/api/bank-accounts`, and `/api/inventory/warehouses`. Shared rows (NULL `branch_id`) are read-only for restricted users. **Branch filter semantics**: when an explicit `?branchId=X` is passed (or implied by user scope), `effectiveBranchCondition` matches `branch_id = X OR branch_id IS NULL` — NULL-branch rows are company-wide/shared (opening JEs, system-generated entries, shared resources) and must remain visible from any branch context. Otherwise picking the only branch in a single-branch company would yield different totals than "all branches" because NULL rows would be silently excluded.
- **Posted Invoice Lock**: Sales and purchase invoice edit screens become read-only (`<fieldset disabled>`) when `existing.status === "posted"`. Modifications require unposting via specific API endpoints.
- **LC Expense Currency Default**: When adding an expense to an LC, if the LC currency is not the company's base currency, the `currencyCode` for the new expense defaults to the **base currency (SAR) with rate=1**. Server-side guards enforce `exchangeRate=1` for base currency entries.
- **Posted-Only Financial Reports**: Trial Balance, Balance Sheet, Income Statement, and Account Statement (`/api/reports/trial-balance`, `/balance-sheet`, `/income-statement`, `/account-statement`) include only journal entries with `status = 'posted'`. Draft (unposted) entries are work-in-progress and have **zero** impact on any financial report — opening, period, closing, running balance, and previous balance all ignore them. Unposting an entry (`POST /api/journal-entries/:id/unpost` flipping status `posted → draft`) instantly removes its impact from every report on the next refresh. System-generated JEs (sales/purchase invoices, vouchers, POS, payroll, production, stock movements) are inserted as `posted` directly, so this filter only affects manually-created draft JEs and entries explicitly unposted via the API.
- **Period Closing Cycle (IFRS-aligned)**: The fiscal-period close has 5 independent steps: validate → close-pl → transfer-profit → soft-close → hard-close. **Soft-close** rejects when revenue/expense accounts still have non-zero balances (`requiresPlClose: true` in the response) unless `force=true` is passed — needed for monthly soft-closes where P&L closes only at year-end. **Hard-close** has NO `force` override — it requires both a `closing_revenue`/`closing_expense` JE AND a `closing_transfer_profit`/`closing_transfer_loss` JE to exist for the period (skipped only when there was zero P&L activity). Recovery from a prematurely hard-closed period requires `POST /api/fiscal/periods/:id/force-reopen` (SuperAdmin only, requires a `reason` ≥ 10 chars, logged via `req.log.warn`). The standard `PATCH /periods/:id/status` still refuses to touch `permanently_closed` periods.
- **SuperAdmin Acting-Company Impersonation**: SuperAdmins can "enter" any tenant via `/admin/enter-company` (or the green button on `/companies`). Selecting a company writes its id to `localStorage.zatca_acting_company_id`, which `lib/api-client-react/src/custom-fetch.ts` auto-attaches to every generated-client request as the `x-acting-company-id` header. The server's `resolveCompanyId` (in `artifacts/api-server/src/middleware/auth.ts`) honours that header **only** when `req.user.role === "superadmin"`; an explicit `?companyId=` query still wins. A sticky amber banner in `Layout.tsx` (`<ActingCompanyBanner/>`) shows the active tenant + a one-click "خروج" that clears the key and invalidates **all** React Query caches (otherwise per-company data would bleed across tenants). The banner is also the only safe exit — never assume an SA is "in their own context" without checking `actingCompanyId` from `useAuth()`.
- **Production Order Post-Issue Lock**: Once a production order moves to `in_production`, the WIP setup fields (raw warehouse, WIP/raw-inventory/labor/overhead accounts, labor & overhead amounts) become read-only via PATCH guard. Changing them after the issue JE has posted would corrupt the WIP balance because the receipt JE would credit a different WIP account than the issue debited. To change them, cancel the order (which auto-reverses the issue) and re-do the cycle. FG-side fields (FG warehouse, FG/variance/waste accounts, costCenter) remain editable until completion.

## Pointers

- **Skills**: `pnpm-workspace`, `react-query`, `drizzle-orm`, `express`, `zod`, `tailwind`, `typescript`, `ai-integration`
- **External Docs**:
    - [ZATCA E-invoicing Regulations](https://zatca.gov.sa)
    - [Drizzle ORM Documentation](https://orm.drizzle.team/docs/overview)
    - [Zod Documentation](https://zod.dev/)
    - [React Query Documentation](https://tanstack.com/query/latest)
    - [OpenAI API Documentation](https://platform.openai.com/docs/overview)