# Overview

This project is a pnpm workspace monorepo providing a comprehensive Saudi ZATCA e-invoicing system. Its main purpose is to streamline financial operations, automate accounting, and ensure ZATCA compliance for multi-company businesses. Key features include CSR generation, invoice submission (clearance and reporting), QR code generation, detailed accounting reports, and robust modules for inventory, accounting, purchasing, and sales. The system aims to enhance financial reporting and operational efficiency for businesses in Saudi Arabia.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

# System Architecture

The system is built as a pnpm workspace monorepo, utilizing Node.js and TypeScript.

## UI/UX Decisions
The frontend uses React with Vite and TailwindCSS for a bilingual (Arabic/English) RTL interface supporting multi-company operations. It features customizable invoice templates, logo uploads, and per-company decimal place settings.

## Technical Implementations
- **Monorepo:** Managed with pnpm workspaces.
- **API:** Developed with Express.js; uses Orval for API hook and Zod schema generation.
- **Database:** PostgreSQL with Drizzle ORM.
- **Validation:** Zod and `drizzle-zod`.
- **Authentication:** JWT-style Bearer tokens, single-session enforcement, real-time validation, bcryptjs for password hashing, and SuperAdmin multi-layer login.
- **ZATCA Integration:** Handles CSR generation (ECDSA secp256k1), compliance/production CSID onboarding, invoice submission, TLV binary encoded QR codes, and UBL 2.1 ZATCA XML generation.
- **Self-Registration:** Public registration flow for new companies and inactive admin users with SuperAdmin approval, country-specific compliance, and dynamic module selection.
- **Soft-Delete Recycle Bin:** Implements soft-delete for companies with restore and permanent purge options.
- **Core Modules:**
    - **Inventory Management:** Tracking warehouses, items, stock, transfers, adjustments, and counts; supports Weighted Average costing and multi-unit.
    - **Fiscal Periods:** Manages fiscal years and periods with status tracking.
    - **Sales Documents:** Includes `priceIncludesVat` flag, document-level discounts, and server-authoritative promotion application.
    - **Quotation to Invoice Linking:** Direct conversion of accepted quotations to sales invoices with atomic updates.
    - **Account Statement Drill-down:** Clickable links in statements to source documents.
    - **Support System:** In-app ticket management.
    - **POS Management:** Monitoring cashier shifts, linking sales invoices to sessions, live KPIs, and terminal management.
    - **Sequence Management:** Centralized administration and auditing of transaction document numbers with concurrent handling.
    - **Financial Transactions:** Full-page UX for cash deposits/withdrawals/transfers.
    - **Receipt Vouchers:** Customer-only form for linking payments to sales invoices.
    - **Payment Vouchers:** Supplier-only form for linking payments to purchase invoices.
    - **Contracting Module:** Manages owner and sub contracts, distinguishes formal contracts from progress billing, and handles both incoming and outgoing progress bills with robust validation.
- **Role-Based Access Control (RBAC) & Audit Log:** Granular permissions and audit trail.
- **Work Sessions:** Tracks user login activity, enforces single active sessions.
- **Manual Sessions:** Admin-defined work shifts.
- **Account Management:** Enforces leaf accounts in transactional UIs.
- **Subscription Management:** Manages plans, lifecycles, and auto-suspension.
- **Backup Operations:** SuperAdmin interface for backup health, manual/scheduled backups, and restore.
- **Cross-Company Report Email Scheduling:** SuperAdmin functionality to auto-email cross-company CSV reports.
- **AI-Powered Features:**
    - **Voice + AI Screen Actions:** Natural-language commands for screen operations.
    - **AI Production Assistant:** Embedded assistant in manufacturing module for explanations and suggestions.
    - **AI Security Event Analysis:** Analyzes images/videos to auto-fill event details.
    - **Real-time Security Alerts:** Configurable notification rules.
    - **In-App Inbox + AI Reports:** Persistent inbox for messages and AI-generated reports with JSON validation.
    - **SEO Connection AI Suggestion:** Super-admin helper to suggest `analyticsPropertyId` + `searchConsoleSiteUrl` from free-text hints, including robust SSRF-hardened fetching.
    - **Tax Entry on Journal Entry Form:** Provides dropdown options to auto-split input/output VAT from journal entry lines, using AI to suggest VAT accounts with keyword-matching fallbacks.

## System Design Choices
- **Modular Monorepo:** Facilitates code reuse and separation of concerns.
- **Database Schema:** Designed for multi-tenancy and complex transactional relationships.
- **API Design:** Adheres to RESTful principles.
- **Security:** Robust security mechanisms including JWTs, bcryptjs, and multi-tenant guards.
- **AI Integration:** Strategic AI integration for suggestions, data processing, and analysis, with rule-based fallbacks.

# External Dependencies

- **pnpm:** Monorepo package manager.
- **Node.js:** JavaScript runtime.
- **TypeScript:** Superset of JavaScript.
- **Express.js:** Web application framework.
- **PostgreSQL:** Relational database.
- **Drizzle ORM:** Object-Relational Mapper.
- **Zod:** Schema declaration and validation.
- **drizzle-zod:** Drizzle ORM and Zod integration.
- **Orval:** OpenAPI client code generator.
- **React:** Frontend library.
- **Vite:** Frontend build tool.
- **TailwindCSS:** Utility-first CSS framework.
- **bcryptjs:** Password hashing.
- **openssl:** Used for CSR generation.
- **OpenAI:** AI services.
- **xlsx (SheetJS):** Library for Excel/CSV parsing and generation.
## Accounting Maintenance & Trial Balance module — menu / permissions registration

A new high-level module key `accounting_maintenance` is registered for the
upcoming "الصيانة المحاسبية وميزان المراجعة" feature (import client trial
balances, edit, compare, post adjustments, approve, convert to closing,
print reports, AI-assisted analysis). Only the menu/permission scaffolding
is in place — the actual page/route is not yet built.

Touched files:
- `artifacts/zatca-invoicing/src/lib/menuItems.ts` — added the entry to
  `MENU_ITEMS` (section "المحاسبة") and mapped `accounting_maintenance →
  "accounting"` in `PERMISSION_TO_MODULE`.
- `artifacts/api-server/src/lib/menuPermissionCatalog.ts` — added the key
  to `CANONICAL_MENU_PERMISSION_KEYS` so the API doesn't strip it.
- `artifacts/zatca-invoicing/src/pages/MenuPermissions.tsx` — added a
  Wrench icon to `MENU_ICONS` so the toggle card on the super-admin
  /admin/menu-permissions screen has a glyph.
- `artifacts/zatca-invoicing/src/lib/permissions.ts` — added an entry to
  `PERMISSION_MODULES` under group `G.accounting` with all six actions
  (view/create/edit/delete/post/export) so the per-user permissions
  dialog includes the new module.
- `artifacts/zatca-invoicing/src/components/Layout.tsx` — added a `NavDef`
  to `accountingSubNav` (route `/accounting/maintenance`, icon Wrench,
  permKey `accounting_maintenance`) and updated `ACCOUNTING_GROUP_PERMS`
  + `MODULE_PERMS["accounting"]` so the group still shows when only this
  permission is granted.
- `artifacts/api-server/src/routes/auth.ts` — added the key to
  `MODULE_PERMISSIONS.accounting` so signing up with the accounting
  billable module auto-grants this permission.
- `artifacts/zatca-invoicing/src/lib/companyModuleGate.ts` and
  `artifacts/api-server/src/middleware/permissions.ts` — added the key
  so a company can disable the module via the company-level gate.
- `ar.json` / `en.json` — added `nav.accountingMaintenance` and
  `perms.modules.accounting_maintenance` translations.

Clicking the new sidebar entry will currently land on the global
not-found page until the maintenance pages are implemented. That is
intentional — the user only requested the menu/permission registration
in this task.

## Accounting Maintenance & Trial Balance module — full implementation

The "الصيانة المحاسبية وميزان المراجعة" module is now fully built end-to-end
on top of the menu/permissions scaffolding above.

DB schema (`lib/db/src/schema/trialBalances.ts`, registered in
`lib/db/src/schema/index.ts`):
- `trial_balances` — header (companyId, fiscalYear, periodStart/End,
  balanceType: opening|before_review|after_review|closing, status:
  draft|in_review|approved, totals, notes, createdBy, approvedBy/At,
  sourceTrialBalanceId for closing-clones).
- `trial_balance_details` — per-account lines with originalDebit/Credit
  preserved alongside current debit/credit, isUnlinked flag for codes
  not found in the chart of accounts, changeReason.
- `trial_balance_adjustments` — adjustment journal-entry references
  (trialBalanceId, journalEntryId, description, category, amount,
  createdBy).
- `trial_balance_logs` — append-only audit trail (action, details JSON,
  userId, createdAt).

Backend (`artifacts/api-server/src/routes/trial-balances.ts`, mounted at
`/api/trial-balances`, gated by `requireModulePermission(
"accounting_maintenance")`):
- Full CRUD, line edit/add/delete with audit log.
- `POST /:id/import` — bulk-imports lines, links accountCode to the
  chart of accounts, marks unlinked rows.
- `GET /:id/compare/:otherId` — line-by-line diff between two trial
  balances of the same company.
- `POST /:id/adjustments` — wraps JE header + JE lines + adjustment row
  + detail mutations in a single `db.transaction`; validates EVERY
  `accountId` belongs to the caller's company up-front (tenant
  isolation), enforces debit=credit on the adjustment.
- `POST /:id/approve` — debit=credit guard, flips to approved, stamps
  approver/timestamp, audited.
- `POST /:id/convert-to-closing` — clones an approved TB into a new
  `balanceType: "closing"` row carrying `sourceTrialBalanceId`.
- `GET /:id/report?type=detailed|summary|before-after|adjustments`.

AI helper (`artifacts/api-server/src/routes/ai.ts` →
`POST /api/ai/analyze-trial-balance`, also gated by
`requireModulePermission("accounting_maintenance")`): detects abnormal
balances (asset/expense with credit, liability/equity/revenue with
debit), suggests an offsetting adjustment when imbalanced. Tries the
configured `OPENAI_BASE`/`OPENAI_KEY` model and falls back to a fully
deterministic rule-based result so the UI works without an AI key.

Frontend (`artifacts/zatca-invoicing/src/pages/accounting/`):
- `TrialBalances.tsx` — list with status/type filters, search, create
  dialog, navigates to detail page.
- `TrialBalanceDetail.tsx` — header card (status, totals, debit-credit
  diff indicator) plus 5 tabs: Lines (edit/delete with reason),
  Compare (against any other TB), Adjustments (add via balanced
  multi-line form), Reports (4 report variants + print), Audit Log.
  Top-bar actions: import, export Excel, AI analyze, approve, convert
  to closing.
- `TrialBalanceImportDialog.tsx` — XLSX/CSV upload via SheetJS with
  Arabic+English header auto-mapping (كود الحساب / مدين / دائن / etc.),
  client-side preview, balance check, replace-existing toggle, and a
  downloadable Arabic template.
- API client at `artifacts/zatca-invoicing/src/lib/trialBalancesApi.ts`.
- Routes wired in `App.tsx` at `/accounting/maintenance` and
  `/accounting/maintenance/:id`, gated by the `accounting_maintenance`
  module permission.
- All UI strings under `trialBalanceMaintenance.*` in both `ar.json`
  and `en.json`.

## Entity Account Auto-Creation (cashbox / bank / customer / supplier / warehouse)

Each entity type has a posting **sub-account** auto-created on POST when
the user does not pick one explicitly.  The parent under which the new
sub-account is filed is configurable from the **Account Mapping** screen
under document-type `entity_account_parents` (5 role keys:
`cash_account_parent`, `bank_account_parent`, `customer_account_parent`,
`warehouse_account_parent`, `supplier_account_parent`).  Defaults seed
to codes 1101 / 1102 / 1103 / 1105 / 2101 respectively.

Generic helper: `artifacts/api-server/src/lib/entityAccounts.ts`
- `ensureEntitySubAccount(...)` resolves the parent in this order:
  1. explicit mapping (with both `companyId` AND `accountType` guards
     so a mis-mapped parent of the wrong type is silently ignored),
  2. `like(code, "<prefix>%")` for a list of fallback prefixes,
  3. `like(nameAr, "%<term>%")` for a list of name terms.
- Generates the next sub-code: concatenated numeric (parent `1102` →
  `11021`, `11022`, …) when the parent code is digits, else
  `<parentCode>-NNN`.
- Idempotent on same-name siblings (returns the existing id).
- Flips the parent to `isPosting=false` once it gains a child.
- Wrapped in a 5-attempt retry loop that catches Postgres unique
  violations on `(company_id, code)` to handle concurrent POSTs.
- Wrappers: `ensureCashBoxAccount`, `ensureBankAccountLedger`,
  `ensureCustomerLedger`, `ensureSupplierLedger`,
  `ensureWarehouseAccount`.

Wired from POST handlers in `cash-boxes.ts`, `bank-accounts.ts`,
`inventory.ts` (warehouses), `customers.ts`, `suppliers.ts`.  All five
JE pipelines already prefer the entity's own `accountId` over the
mapping fallback (pre-existing behaviour, untouched).

## Company Logo on Print Surfaces

The configured company logo (stored on `companies.logo` as a base64
data URL or absolute http(s) URL, managed in General Settings) is
rendered on every print/PDF surface across the system:

- **Generic reports** (30+ via `ExportButtons` → `lib/export.ts`):
  `exportToPDF` and `printSectionsAsPDF` accept an optional `logo`
  parameter and render a centered, white-rounded-card-wrapped `<img>`
  above the title in the green header.  `ExportButtons` reads
  `useAuth().user.company.logo` and forwards it automatically.
- **Sales prints** — all 7 templates (`SalesPrintModal.tsx`):
  - Templates 1/3/5 via the `companyBlock(c)` helper (logo on top of
    the textual block).
  - Templates 2/4 via an inline IIFE in the colored top-bar header.
  - Templates 6/7 (thermal 80 mm) via `logoCenterHtml(c)`.
- **Purchase prints** — all 5 templates (`PurchasePrintModal.tsx`):
  - Templates 1/3/5 via shared `companyBlock(c)`.
  - Templates 2/4 via inline IIFE in the colored header.
- **Journal Entries** (`JournalEntries.tsx` list-print and
  `JournalEntryForm.tsx` single-entry print): logo + Arabic name in
  the top centred header of `buildPrintHtml` / `buildEntryPrintHtml`.
- **End of Service** (`EndOfService.tsx`): hidden on screen via
  `hidden print:block`, revealed only when `window.print()` is
  invoked on the React DOM.
- **VAT Declaration** (`VATDeclaration.tsx`): forwards
  `data.company.logo ?? user.company.logo ?? null` to
  `printSectionsAsPDF`.
- **POS Cashier receipt** (`artifacts/pos/src/pages/Cashier.tsx`):
  `ReceiptModal` accepts `companyLogo` + `companyNameAr` props and
  renders a print-only header (`hidden print:block`) above the
  confirmation banner.

### Security: `safeLogoSrc` allowlist
All print surfaces stitch HTML by string interpolation into
`document.write()`, so any company-supplied `logo` value reaches the
browser as raw HTML.  To eliminate stored-XSS risk, every logo value
is run through `safeLogoSrc(raw)` (exported from
`artifacts/zatca-invoicing/src/lib/export.ts`) before insertion.  The
helper accepts only well-formed
`data:image/(png|jpeg|jpg|gif|webp|svg+xml);base64,...` URIs and
absolute `https?://` URLs whose bodies use only safe URL chars.
Anything containing `"`, `'`, `<`, `>`, backtick, whitespace, or
control chars is rejected (returns `null`), which the callers render
as "no logo" — graceful degradation, no exception.
