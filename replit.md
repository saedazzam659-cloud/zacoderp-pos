# Overview

This project is a pnpm workspace monorepo using TypeScript, designed as a comprehensive Saudi ZATCA e-invoicing system. It supports multi-company operations with a bilingual (Arabic/English) RTL UI. The system aims to streamline financial operations, enhance reporting, and automate accounting processes in compliance with ZATCA regulations, including CSR generation, invoice submission (clearance and reporting), QR code generation, and detailed accounting reports. It also features robust modules for inventory management, accounting, purchasing, and sales.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

# System Architecture

The system is built as a pnpm workspace monorepo, leveraging Node.js and TypeScript.

**UI/UX Decisions:**
The frontend uses React with Vite and TailwindCSS, supporting a multi-company, Arabic/English RTL interface. It includes customizable invoice design templates, logo uploads, and decimal place settings per company.

**Technical Implementations:**
- **Monorepo:** pnpm workspaces.
- **API:** Express.js framework with Orval for API hook and Zod schema generation from OpenAPI specifications.
- **Database:** PostgreSQL with Drizzle ORM.
- **Validation:** Zod and `drizzle-zod`.
- **Authentication:** JWT-style Bearer tokens, single-session enforcement, real-time validation, and bcryptjs for password hashing.
- **SuperAdmin Multi-Layer Login:** Dedicated hardened flow at `/api/auth/superadmin/*` with email OTP (60s TTL, console fallback when SMTP unset), trusted-device fingerprinting + per-device approval workflow, IP-based risk scoring (new IP / new device / off-hours / recent failures), in-memory per-username + per-IP rate limiting, optional Cloudflare Turnstile, multi-session management, plain-text login-attempt audit log, and account recovery via backup codes + emailed time-limited link. Separate `sa_sessions` token table coexists with legacy `users.sessionToken`; the `resolveBearerToken` middleware helper makes `/me`, `/profile`, `/logout`, and admin guards transparently accept either. SA Security Center UI lives at `/admin/security-superadmin`; recovery flow at `/recover-superadmin/:token`. Email transport prefers SMTP and falls back to the Microsoft Outlook connector (with attachments) when SMTP is unavailable. **SuperAdmin account management:** the Security Center includes a "حسابات السوبر أدمن" tab that lists all SA accounts and lets an authenticated SA create new ones (`POST /api/auth/superadmin/users`), gated by step-up authentication (re-enter current password), strict per-actor rate limit (5/hour), DB-enforced uniqueness with 409 on conflict, and an audit log entry on both success (`module=superadmin_accounts action=create`) and step-up failure (`action=create_denied`).
- **ZATCA Integration:** CSR generation (ECDSA secp256k1), APIs for compliance, production CSID onboarding, and invoice submission. QR code generation uses TLV binary encoding with `qrcode.react`. XML generation adheres to UBL 2.1 ZATCA namespace.
- **Self-Registration:** Public `POST /api/auth/register` (multi-step wizard at `/register`) creates a `pending` company + an `inactive` admin user awaiting SuperAdmin approval. Step 0 includes a country selector (defaults to `SA`; `AE`/`KW`/`QA`/`BH`/`OM`/`EG`/`GLOBAL` supported) that drives a country-specific compliance policy preview (bilingual data in `artifacts/zatca-invoicing/src/lib/countries.ts`) and auto-derives the default currency. Step 3 has an explicit "I accept the country policy" checkbox that disables the submit button until checked, and is reset whenever the country is changed (no policy-surfing). The backend mirrors the country→currency map inline (`COUNTRY_CURRENCY` in `routes/auth.ts`) and seeds a `currenciesTable` row with `isDefault=true` for the new company immediately after the company insert; seeding errors are logged but do NOT abort the registration (graceful degradation — admins can fix from Settings → Currencies). **Step 1 (Plan) was redesigned into a module-by-module picker:** a multi-select industry chip row (تجاري/صناعي/مقاولات/طبي/فنادق, catalog at `lib/industries.ts`) auto-pre-selects each industry's recommended modules (UNION across selected industries) — the user can then add/remove individual modules from a category-grouped catalog (`lib/systemModules.ts`, 8 high-level modules: sales/purchasing/inventory/pos/cash/accounting/hr/zatca). The plan tier (starter/professional/enterprise) defines an `includedModules` budget; total = base plan + max(0, selected − included) × avg-module-price (memoized via `useMemo`). The dynamic price is sent to the backend as `price` (override of the static plan price) and persisted to `subscriptions.price`; the user-selected industries are joined into `companies.industryName` (CSV) and the selected modules expand server-side (authoritative `MODULE_PERMISSIONS` map in `routes/auth.ts`) into `companies.menuPermissions` JSON so a tampered request cannot grant arbitrary permissions.
- **Modules:**
    - **Inventory Management:** Tracks warehouses, items, stock balance, ledger, transfers, adjustments, and counts using Weighted Average costing and multi-unit support.
    - **Fiscal Periods:** Manages fiscal years and periods, including status tracking, auto-splitting, and overlap detection.
    - **Sales Documents:** `priceIncludesVat` flag and document-level discount implementation. Auto-applies promotions: the Sales Invoice form continuously matches the cart against active offers via `POST /api/offers/match` (server-authoritative). Engine returns line-level matches (`line_pricing`, `buy_x_get_y`) and a document-level match (`percentage_total`, `fixed_total`), each carrying an `appliedMode` ("price"|"percent"|"bxgy") so the form writes EITHER unit-price OR discount %, never both. Cart sig + matcher payload use `baseUnitPrice` (the pre-engine snapshot per line) so the engine never re-evaluates against its own output — closes the cross-cycle compounding loop. Engine-owned fields are tracked per line (`engineUnitPrice`, `engineDiscount`) so manual edits are never silently wiped on no-match. Persisted via `sales_invoices.document_offer_id` + `sales_invoice_lines.applied_offer_id` (FK→offers, ON DELETE SET NULL), and `offers.times_used` is bumped tenant-scoped only for offer ids new to the invoice on POST/PUT. Tenant guard `validateOffersBelongToCompany` rejects cross-tenant offer FKs at write time, and the GET join is also tenant-scoped.
    - **Support System:** In-app ticket system with admin replies.
    - **POS Management:** Monitors cashier shifts, links sales invoices to sessions, provides live KPIs, and manages POS terminals.
    - **Sequence Management:** Centralized, admin-only module for managing and auditing transaction document numbers with concurrent handling and integrity guards. Each sequence keeps **per-branch counters** (table `sequence_counters`, keyed by `(sequence_id, branch_id)` with a `branch_id=0` sentinel for null/warehouse-scoped flows): every branch issues its own independent stream, the sequence master row is never mutated during issuance (display/seed-only), counters seed at `start_number` (with a one-time `MAX(start_number, master.current_number)` migration heuristic for the first counter on a pre-upgrade sequence), the peek endpoint and reset endpoint are branch-aware, and `sequence_logs` remains the source of truth for "ever issued?" guards.
- **Role-Based Access Control (RBAC) & Audit Log:** Granular per-module permissions, middleware for handler gating and audit recording. Frontend uses components for page-level guards and permission-aware sidebar.
- **Account Management:** Enforcement of leaf accounts in transactional UIs and server-side validation.
- **Subscription Management:** Differentiated plans, lifecycle management with status tracking, bulk actions, and an auto-suspend nightly job for expired subscriptions.
- **Backup Operations:** SuperAdmin oversight screen for backup health, manual/scheduled backups, and restore functionality with VAT verification.
- **Cross-Company Report Email Scheduling:** SuperAdmin Reports Hub (`/admin/reports`) includes an "EmailScheduleSection" allowing weekly/monthly auto-email of selected cross-company CSV reports (currently Operational Summary + Revenue by Plan). Settings stored in singleton `report_email_schedules` (id=1); every send recorded in `report_email_schedule_runs` with trigger (`scheduled`/`manual`), status, message, reports list and recipient count. A 15-minute cron tick (30s startup delay) in `lib/reportScheduler.ts` gates next-send by frequency (7d weekly / 30d monthly). Endpoints: `GET/PUT /api/admin/reports/email-schedule`, `POST /api/admin/reports/email-schedule/run-now`. CSVs are UTF-8 BOM with Arabic headers; emails sent via existing `sendReportsDigest()` helper (nodemailer with attachments). When SMTP env vars are absent the run is recorded as failed with an Arabic explanation and the UI disables Send Now and shows an amber banner.
- **AI-Powered Features:**
    - **Voucher Suggestions:** AI suggestions for counterparty accounts in vouchers.
    - **Data Import/Export:** Unified center for lossless export and arbitrary file import across 8 entities with AI mapping and transactional upsert.
    - **System Auto-Discovery:** AI System Repair screen automatically discovers system structure (APIs, DB, frontend screens, widgets) for analysis and Arabic markdown summaries.
    - **Maintenance Scheduler:** Background scheduler runs all 11 maintenance checks on every active company at a SuperAdmin-configurable daily time (default 03:00 KSA). Outcomes are persisted to `maintenance_runs`; the AI Company Fix screen shows "آخر فحص" badges per tool, and the SuperAdmin dashboard surfaces a critical-alert banner (snoozable) when any tool reaches the critical threshold.
      - General tools (6): journal-pending, broken-refs, unlinked-accounts, sequence-gaps, dormant-users, orphan-stock.
      - **المخزون (2):** negative-stock (read-only), stock-balance-drift (fix recomputes balance from stock_ledger).
      - **القيود المحاسبية (1):** unbalanced-entries (read-only — posted JEs where SUM(debit) ≠ SUM(credit)).
      - **السجلات (2):** old-audit-logs (delete >365d), old-maintenance-runs (delete >90d).

**System Design Choices:**
- **Modular Monorepo:** Promotes code reusability and separation of concerns.
- **Database Schema:** Designed for multi-tenancy and complex relationships.
- **API Design:** RESTful API with distinct routes.
- **Security:** JWTs, bcryptjs, and multi-tenant guards.
- **AI Integration:** AI endpoints for suggestions and data mapping, with rule-based fallbacks.

# External Dependencies

- **pnpm:** Monorepo package manager.
- **Node.js:** Runtime environment.
- **TypeScript:** Programming language.
- **Express:** Web application framework.
- **PostgreSQL:** Relational database.
- **Drizzle ORM:** Object-Relational Mapper.
- **Zod:** Schema declaration and validation library.
- **drizzle-zod:** Drizzle ORM and Zod integration.
- **Orval:** OpenAPI client code generator.
- **esbuild:** Bundler.
- **React:** JavaScript library for UIs.
- **Vite:** Frontend tooling.
- **TailwindCSS:** CSS framework.
- **bcryptjs:** Password hashing library.
- **qrcode.react:** React component for QR code generation.
- **openssl:** Used for CSR generation for ZATCA.
- **OpenAI:** For AI-powered suggestions and validations.
- **xlsx (SheetJS):** Excel/CSV parsing and generation for Import/Export center.

## Posted Document Lock (April 2026)
- Any document with `status='posted'` is read-only on the edit screen across all modules: sales invoices, sales returns, purchase invoices, purchase returns, receipt/payment vouchers, cash transfers, stock transfers/adjustments/counts, payroll runs.
- Backend enforcement: every PUT/DELETE on document tables returns 409 if status='posted' (sales/purchasing PUT routes now have a guard that selects `status` first and rejects posted records). Vouchers, transfers, adjustments and counts already had this guard.
- Unpost endpoints (`/unpost`) are gated by the new `requireAdminRole` middleware (admin/superadmin/manager only) and enforce multi-tenant `companyId` checks.
- Frontend: a shared `<PostedDocumentBanner>` component (`src/components/PostedDocumentBanner.tsx`) renders an emerald lock banner with an admin-only "فك الترحيل" (Unpost) button + AlertDialog confirmation. Integrated into `SalesDocumentForm` (invoices + returns) and `PurchaseInvoiceForm`. The form body is wrapped in `<fieldset disabled={isPosted}>` and the Save button is hidden when posted.
- Cash/inventory/HR list-modal screens already hid edit actions for posted rows; the new backend admin gate completes their protection.

## Detailed Party Movement Reports (April 2026)
- New report endpoints `GET /customer-statement-detailed` (sales-analytics) and `GET /supplier-statement-detailed` (purchases-analytics) extend the existing simple statements with embedded `lines[]` (item code/name, unit, qty, unit price, discount, vatRate, vatAmount, netAmount, lineTotal — VAT honors the document's `priceIncludesVat` flag) for invoices/returns and a voucher `meta` block (paymentType, cashBoxName, bankAccountName, refNumber, description) for receipts/payments. Sign convention mirrors the simple statements (customer: invoice=debit, return/receipt=credit; supplier: invoice=credit, return/payment=debit) so the running balance matches.
- Backend uses batched `inArray` lookups for line items and voucher cash-box/bank names to avoid N+1.
- Frontend pages: `src/pages/sales/reports/CustomerStatementDetailed.tsx` and `src/pages/purchasing/reports/SupplierStatementDetailed.tsx`. Each row is expand/collapse (chevron column, `Set<string>` of expanded keys) — invoices/returns reveal an inset line-items table with discount + VAT subtotals; receipts/payments reveal a voucher details grid (سند قبض / سند صرف). RTL-aware chevron flip, opening/closing summary cards, and ExportButtons that include parent rows + bullet detail rows in the CSV/PDF export.
- API client methods: `salesAnalyticsApi.customerStatementDetailed(...)` and `purchaseAnalyticsApi.supplierStatementDetailed(...)` with full TypeScript types (`CustomerStatementDetailedRow` / `SupplierStatementDetailedRow` plus `*LineItem` and `*Meta` shapes).
- Routing: `/sales/reports/customer-statement-detailed` (module `sales_reports`) and `/purchasing/reports/supplier-statement-detailed` (module `suppliers`). Sidebar nav (`Layout.tsx`) and i18n keys (`navExtra.{customer,supplier}StatementDetailed`, `salesReports.customerStatementDetailed.*`, `purchasingReports.supplierStatementDetailed.*`) added in both ar.json and en.json.