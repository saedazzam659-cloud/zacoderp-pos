# Overview

This project is a pnpm workspace monorepo using TypeScript, focused on developing a comprehensive Saudi ZATCA e-invoicing system. It supports multi-company operations, features a bilingual (Arabic/English) RTL UI, and aims to provide a robust solution for various business functions including invoicing, inventory management, accounting, purchasing, and sales, all while ensuring compliance with ZATCA regulations. The system is designed to streamline financial operations, enhance reporting capabilities, and automate complex accounting processes, offering significant market potential for businesses operating in Saudi Arabia. Key capabilities include ZATCA integration for CSR generation, invoice submission (clearance and reporting), QR code generation, and detailed accounting reports.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

## Permissions Policy (MANDATORY)

Whenever a new screen, page, or backend module is added to the system, it MUST be wired into the permissions system in the SAME change set — never as a follow-up. Concretely, every new feature must include:

1. **Register the module** in `artifacts/zatca-invoicing/src/lib/permissions.ts` (`PERMISSION_MODULES`) with: a stable `key`, an i18n `label` (`perms.modules.<key>`), the right `group` (reuse one of the existing `G.*` groups, or add a new `G.<name>` + `perms.groups.<name>` if a new domain is being introduced), and the appropriate `actions` set (`VO`, `VC`, or `ALL`; include `post` / `export` only when the screen actually has those operations).
2. **Add Arabic + English labels** for the new module key (and group key, if new) in `artifacts/zatca-invoicing/src/i18n/locales/ar.json` and `en.json` under `perms.modules.*` and `perms.groups.*`.
3. **Gate the route** in `artifacts/zatca-invoicing/src/App.tsx` by wrapping the new `<Route>` with `<PermRoute module="<key>" …>` (use `isSuperAdmin` split if superadmin needs raw access). Never leave a new screen behind a plain `<Route>`.
4. **Gate the sidebar entry** in `artifacts/zatca-invoicing/src/components/Layout.tsx` by giving every new `NavDef` entry an explicit `permKey: "<key>"`. If the new screen lives in a brand-new collapsible group, also add a `*_GROUP_PERMS` constant and `if (!groupVisible(user, *_GROUP_PERMS)) return null;` at the top of the corresponding `NavGroup` component, so the whole group disappears for users with no perms in it.
5. **Gate the backend** in `artifacts/api-server/src/routes/<route>.ts`: add `router.use(extractAuth)` + a `requireAuthed` 401 gate at minimum, then `requirePermission("<key>", "<action>")` + `audit("<key>", "<action>")` on each handler (or `requireModulePermission(<key>)` for single-purpose routers). Anonymous callers must always receive 401, not data.

`admin` and `superadmin` always bypass step 5's granular checks (handled inside the middleware), so existing privileged users keep working without manual intervention. The result of these five steps is that the new screen is automatically hidden in the sidebar, blocked at the URL, blocked at the API, and immediately visible/toggleable in the Users → Permissions tab — all from the same commit.

## Branch Filter Policy (MANDATORY)

Every new **report** added to the system MUST support filtering by branch out of the box, with no manual workaround. A report is defined as any read-only page that renders aggregated, transactional, or analytical data (sales/purchasing/cash/inventory/accounting/tax/HR/POS reports, statements, ledgers, agings, dashboards, exports). The rule applies whether the report is new or being modified. Pull requests that introduce a new report without branch support must be rejected.

The five steps required for every new report:

1. **Frontend filter (UI):**
   - Use the shared `artifacts/zatca-invoicing/src/components/BranchFilter.tsx` component. Do NOT build a custom branch picker — the shared component already handles loading state, RTL, label/icon, the "كل الفروع / All branches" sentinel option, and (when extended) multi-select.
   - Place the `<BranchFilter value={branchId} onChange={setBranchId} />` control at the **top of the report**, in the same toolbar/filter bar as the date range and any other filters, before the data table/chart. Must be visible without scrolling.
   - Default value is `undefined` ⇒ the option labelled `common.allBranches` ("كل الفروع") is selected. Single-branch (`number`) and multi-branch (`number[]`, when the report opts into the multi-select variant) are both supported.

2. **State + cache key:**
   - Store the selected branch in component state (`useState<number | undefined>(undefined)`).
   - Include `branchId` in the React-Query `queryKey` (e.g. `["sales-by-customer", cid, from, to, branchId]`) so changing the filter triggers a refetch and does not return stale cached rows.

3. **API helper / route:**
   - Thread `branchId` through the corresponding helper in `artifacts/zatca-invoicing/src/lib/{sales,purchase,cash}AnalyticsApi.ts` (or the relevant lib module) and append it via the existing `qs()` query-string builder. Never append it ad-hoc inside the page component.
   - On the backend (`artifacts/api-server/src/routes/*.ts`), parse `req.query.branchId` and apply it inside the SQL/Drizzle WHERE clause via the shared helper `branchScopeFilter(req, <table>.branchId)` from `middleware/auth.ts`. Filtering happens in the database query, not in JS post-processing, so pagination and aggregates stay correct.

4. **Per-user branch scoping (server-enforced, automatic):**
   - The shared `branchScopeFilter(req, branchColumn)` helper already AND-combines the explicit `?branchId=…` filter with the caller's `viewAllBranches` / `userBranches` grants. A user limited to specific branches will only ever receive rows for those branches, even if they tamper with the query string. `admin` and `superadmin` always bypass.
   - Therefore: **never write a raw `eq(table.branchId, req.query.branchId)`**. Always go through the helper, so per-user permissions are enforced as a single source of truth.

5. **Exports inherit the filter:**
   - PDF, Excel, CSV and print views of the report MUST honour the same `branchId` (and the same per-user scope from step 4). Concretely: pass `branchId` into the export endpoint / client-side export builder so the exported rows match exactly what is on screen. Do not regenerate the export from a separate unfiltered query.

**Enforcement:** the audit script `scripts/audit-branch-filter.cjs` (`pnpm audit:branch-filter` from the repo root) scans every page under `artifacts/zatca-invoicing/src/pages/**` whose name matches a report pattern (`*Report.tsx`, `*Statement.tsx`, `*Balances.tsx`, `*Aging*.tsx`, `*ByCustomer.tsx`, `*ByItem.tsx`, `*ByPeriod.tsx`, `*BySupplier.tsx`, `VATDeclaration.tsx`, `ZatcaReport.tsx`, `IncomeStatement.tsx`, `AccountStatement.tsx`, `CashFlowReport.tsx`, etc.) and warns on any file that does not import `BranchFilter`. Run it locally before opening a PR; a failing run is a blocker, not a warning.

# System Architecture

The system is built as a pnpm workspace monorepo, leveraging Node.js and TypeScript.

**UI/UX Decisions:**
The frontend uses React with Vite and TailwindCSS, supporting a multi-company, Arabic/English RTL interface. Design templates for invoices (Classic, Modern, Professional, Colored, Compact) are provided. Logo uploads and decimal place settings are customizable per company.

**Technical Implementations:**
- **Monorepo Tool:** pnpm workspaces.
- **API Framework:** Express.
- **Database:** PostgreSQL with Drizzle ORM.
- **Validation:** Zod and `drizzle-zod`.
- **API Codegen:** Orval generates API hooks and Zod schemas from an OpenAPI specification.
- **Build System:** esbuild for CJS bundle generation.
- **Authentication:** JWT-style Bearer tokens, single-session enforcement, real-time session validation, and bcryptjs for password hashing.
- **ZATCA Integration:** CSR generation (ECDSA secp256k1 with ZATCA-specific OIDs), APIs for compliance, production CSID onboarding, and invoice submission. QR code generation uses TLV binary encoding rendered via `qrcode.react`. XML generation adheres to UBL 2.1 full ZATCA namespace.
- **Subscription Plans:** Differentiated plans (Starter, Professional, Enterprise) based on users and invoice limits.
- **Menu Permissions:** Flexible system for superadmins to toggle menu visibility per company, stored as JSON.
- **Inventory Management Module:** Comprehensive tracking including warehouses, items, stock balance, ledger, transfers, adjustments, and counts. Costing method: Weighted Average. Multi-unit per item support. Stock Transfer and Adjustment modules include auto Journal Entry generation and AI-powered account suggestions.
- **Fiscal Periods Module:** Manages fiscal years and periods with status tracking, auto-splitting into monthly periods, and overlap detection.
- **Sales Document Enhancements:** `priceIncludesVat` flag for dynamic VAT calculation and document-level discount implementation.
- **Voucher AI Suggestions:** AI-powered suggestions for counterparty accounts in Receipt and Payment Vouchers.
- **Support Messages System:** In-app support ticket system with admin replies, configurable delivery channels (in-app notifications, webhooks, Telegram), and superadmin inbox.
- **POS Monitoring:** Tracks cashier shifts (open/closed), links sales invoices to sessions, and provides live KPIs, active session monitoring, and cashier ranking.
- **POS Terminals (طرق البيع / المحطات):** Admin-managed POS stations that link a branch to a specific physical machine (auto-paired by `localStorage.pos_device_id` on first cashier login) and optionally a cash box. Cashier login is a 2-stage wizard: credentials → branch+terminal picker. Session opening is wrapped in a DB transaction with `SELECT … FOR UPDATE` on the terminal row, preventing two cashiers from grabbing the same station and two devices from racing to claim an unpaired terminal. All mutating endpoints (`POST/PATCH/DELETE/unpair`) require `admin` or `superadmin` role; cross-tenant `branchId`/`cashBoxId` linkage is rejected.
- **RBAC + Audit Log (Phase 1):** Granular per-module permissions are stored on `users.permissions` (jsonb shape `{ moduleKey: { view, create, edit, delete, post, export } }`). The api-server middleware in `middleware/permissions.ts` provides four primitives: `requirePermission(module, action)` for per-handler gating, `requireModulePermission(defaultModule)` for single-purpose routers, `pathRbac([[prefix, module], …])` for multi-purpose routers (e.g. `sales.ts`), and `audit/moduleAudit` for fire-and-forget audit recording. Action inference is method-based with path-suffix overrides so `POST /:id/post`, `/:id/cancel`, `/:id/approve`, `/:id/reverse` and `/export` are gated and logged as the correct semantic action (`post` / `export`) rather than `create`. `admin` and `superadmin` roles bypass all granular checks. **Critically**, `requireModulePermission` and `pathRbac` hard-require `req.authUser` on every method including GET — anonymous reads on protected routers return 401 and cannot leak tenant data via `?companyId=`. The `audit_log` table records every mutation (and every denial) with userId/companyId/module/action/method/path/statusCode/ip/userAgent. Admin-only viewer at `/admin/audit-log` (sidebar entry visible to both admin and superadmin) with filter-by-module/user/method/date and pagination, served by `GET /api/audit-log` (companyId-scoped for admins, optionally cross-tenant for superadmin via `?companyId=`). Frontend `RequirePermission` / `PermRoute` / `usePermission` provide page-level guards that admins/superadmins bypass automatically.
- **RBAC Phase 2 — Sidebar/Menu Hiding + Backend hard-auth sweep:** Beyond per-page deny screens, the sidebar itself is now permission-aware so users only ever see the menu items they can actually use. `Layout.tsx` introduces a `groupVisible(user, GROUP_PERMS)` helper plus per-group `*_PERMS` constants that mirror the modules guarding each group's routes (e.g. `SALES_PERMS = ["customers","sales_invoices","sales_returns",…]`, `INVENTORY_REPORTS_PERMS = ["items"]`). Every collapsible NavGroup (Cash, CashReports, Purchasing, PurchasingReports, Sales, SalesReports, Inventory, InventoryReports, Reports, Accounting) calls `useAuth()` then early-returns `null` when the user has no `view` perm on any module in the group — admin/superadmin bypass keeps everything visible to them. Each leaf NavItem (including all report subnav entries) carries an explicit `permKey` so single links also disappear when the user lacks permission. Routes are double-gated: every company-facing route in `App.tsx` is wrapped in `<PermRoute module="…">` (POS routes use `module="pos"`), so direct URL access by an unauthorized user lands on the Arabic deny screen rather than the page. **Backend hard-auth sweep:** four legacy routers that were mounted with either no auth or only the non-blocking `extractAuth` were hardened: `routes/zatca.ts` now has `extractAuth` + `requireAuthed` + per-route `requirePermission("zatca_setup"|"zatca_bridge","create")` + `audit(...)` on all 5 mutation endpoints; `routes/companies.ts`, `routes/reports-accounting.ts` and `routes/reports.ts` got router-level `extractAuth` + `requireAuthed` so anonymous reads/writes return 401 (admin/superadmin still pass through); `routes/storage.ts` got per-route `extractAuth` + `requireAuthed` on `/storage/uploads/request-url` and the private `/storage/objects/*` (the public `/storage/public-objects/*` path stays open by design). HR routes are intentionally not gated yet (no HR perm module is defined).
- **Leaf-Account Enforcement:** Parent (header) accounts cannot be selected in any transactional UI. The shared `AccountCombobox` greys out parent rows (any account whose id is referenced as `parentId` of another, or with `isPosting=false`) with a "رئيسي" badge and `aria-disabled`; `SearchCombobox` skips disabled rows for mouse/click/Enter and snaps the keyboard highlight to the first enabled row. Server-side, `lib/leafAccount.ts → ensureLeafAccounts(companyId, ids)` is called from `journalEntries` POST/PUT (validation runs before any header mutation) and from `accounting-mappings PUT /bulk`. Validation also enforces multi-tenant integrity by rejecting any account id not present in the caller's company. Error message: `لا يمكن اختيار حساب رئيسي، يرجى اختيار حساب فرعي` followed by the offending account code/name.

**System Design Choices:**
- **Modular Monorepo:** Promotes code reusability and separation of concerns.
- **Database Schema:** Designed for multi-tenancy and complex relationships.
- **API Design:** RESTful API with distinct routes for various modules.
- **Security:** JWTs, bcryptjs, and multi-tenant guards for data isolation.
- **AI Integration:** AI endpoints for suggesting accounts in various modules, with robust rule-based fallbacks.

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
- **OpenAI:** For AI-powered suggestions and validations (e.g., Journal Entry Validation, Data Import column mapping).
- **xlsx (SheetJS):** Excel/CSV parsing and generation for Import/Export center.

## Recent Features

### Centralized Sequence Management (`/settings/sequences`)
Single source of truth for all transaction document numbers (مسلسل الحركات). Admin-only module that issues monotonically increasing numbers per company per transaction type, with full audit log and capacity tracking.

- **Schema:** `lib/db/src/schema/sequences.ts` — `sequencesTable` (companyId, code UNIQUE per company, prefix, startNumber, endNumber, currentNumber, padLength, isActive, transactionTypes jsonb string[]) + `sequenceLogsTable` (sequenceId, transactionType, generatedNumber, userId, refTable, refId, createdAt). `SEQUENCE_TX_TYPES` const lists all 11 supported types.
- **Helper:** `artifacts/api-server/src/lib/sequences.ts` → `nextSequenceNumber(companyId, txType, ctx?)`. Uses `SELECT … FOR UPDATE` in its own short transaction (does NOT join caller's tx — gaps acceptable, prevents number reuse on rollback). Returns `null` if no active sequence configured (caller falls back to legacy null-docNumber behavior). Throws `SequenceCapacityExceededError` on exhaustion.
- **API:** `artifacts/api-server/src/routes/sequences.ts` registered at `/api/sequences`, all admin-only via `requireAdminRole`. Endpoints: `GET /` (list with usage %), `GET /:id`, `GET /:id/logs`, `GET /transaction-types`, `POST /` (validates uniqueness of code + no conflicting active tx-type binding), `PATCH /:id`, `POST /:id/reset`, `DELETE /:id` (only if unused — currentNumber === startNumber).
- **Wired into:** `journalEntries.ts` POST, `sales.ts` POST `/sales-invoices` (skips ZATCA-issued), `purchasing.ts` POST `/purchase-invoices`. All three only invoke the helper when client omits `docNumber` and gracefully fall back to legacy null when no active sequence exists — fully non-breaking rollout.
- **Frontend:** `artifacts/zatca-invoicing/src/pages/settings/Sequences.tsx` — table with usage progress bar, CRUD dialog with multi-select transaction-type checkboxes, reset confirm, logs viewer (last 50). Permission `sequences` under G.dashboard, sidebar entry gated by `requireAdmin: true` + `user?.role === "admin"` defense-in-depth check on the route.
- **Out-of-scope follow-ups:** POS receipts, stock issues/receipts/transfers, vouchers retrofit, AI capacity-alert features.

### AI-Powered Data Import/Export Center (`/settings/data-io`)
Unified Settings module accessible to company admins (gated by `general_settings` permission). Supports lossless export and arbitrary file import for 8 entities: accounts, customers, suppliers, items, warehouses, branches, cashBoxes, bankAccounts.

- **Backend:** `artifacts/api-server/src/routes/data-io.ts` — `ENTITIES` catalog defines per-entity `FieldDef` (type, required, enum, FK refs, business keys). Endpoints under `/api/data-io`:
  - `GET /entities` — catalog for client UI
  - `POST /export` — JSON or `xlsx` download (multi-sheet; metadata wrapper `{meta, data}`)
  - `POST /import/analyze` — AI mapping (OpenAI proxy `gpt-5.4`, JSON-mode) with deterministic fuzzy fallback; returns `{src: {field, confidence}}`
  - `POST /import/process` — applies mapping, normalizes (dates/numbers/booleans), resolves FKs (`parentCode`→`parentId`), detects issues (`missing_required`, `invalid_format`, `fk_unresolved`, `fk_resolved`, `duplicate`, `value_normalized`)
  - `POST /import/commit` — transactional upsert with chunking (CHUNK=200), per-row log
- **Frontend:** `artifacts/zatca-invoicing/src/pages/settings/DataImportExport.tsx` (4-step wizard: upload → analyze/map → review → result) + `artifacts/zatca-invoicing/src/lib/dataIoApi.ts` (typed client). Uses `xlsx` client-side to parse `.xlsx`/`.csv`/`.json`. Downloadable post-import Excel report.
- **Auth & Multi-tenant safety:** Admin-only via existing branch isolation middleware. All reads/writes filtered by `companyId`. Defense-in-depth: (1) commit re-resolves `existingId` server-side from business-keys (client-supplied `__existingId` ignored), update WHERE includes `companyId` guard; (2) any client-supplied `*Id` column (parentId, currencyId, etc.) is validated against a tenant-scoped valid-id set in `cleanRow` and stripped + warned-on if foreign; (3) strict mode (`skipErrors:false`) returns 422 with structured per-row log on validation OR tx-time DB failure.
- **Operational caps:** Express body limit raised to 25MB for import payloads. Export capped at 12 entities × 50,000 rows per request (returns 413 / `meta.truncated` respectively).