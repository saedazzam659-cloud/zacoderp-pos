# Overview

This project is a pnpm workspace monorepo using TypeScript, designed to be a comprehensive Saudi ZATCA e-invoicing system. It supports multi-company operations, features a bilingual (Arabic/English) RTL UI, and aims to streamline financial operations, enhance reporting capabilities, and automate complex accounting processes in compliance with ZATCA regulations. Key capabilities include ZATCA integration for CSR generation, invoice submission (clearance and reporting), QR code generation, and detailed accounting reports, along with robust modules for inventory management, accounting, purchasing, and sales.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

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
- **Inventory Management Module:** Comprehensive tracking including warehouses, items, stock balance, ledger, transfers, adjustments, and counts. Costing method: Weighted Average. Multi-unit per item support.
- **Fiscal Periods Module:** Manages fiscal years and periods with status tracking, auto-splitting into monthly periods, and overlap detection.
- **Sales Document Enhancements:** `priceIncludesVat` flag for dynamic VAT calculation and document-level discount implementation.
- **Voucher AI Suggestions:** AI-powered suggestions for counterparty accounts in Receipt and Payment Vouchers.
- **Support Messages System:** In-app support ticket system with admin replies, configurable delivery channels.
- **POS Monitoring:** Tracks cashier shifts, links sales invoices to sessions, and provides live KPIs and cashier ranking.
- **POS Terminals:** Admin-managed POS stations linked to branches and optionally cash boxes, with a 2-stage cashier login process and transactional session opening to prevent conflicts.
- **RBAC + Audit Log:** Granular per-module permissions stored on `users.permissions` (jsonb). Middleware provides `requirePermission`, `requireModulePermission`, `pathRbac`, and `audit/moduleAudit` primitives for handler gating and audit recording. Admin/superadmin roles bypass granular checks. `audit_log` table records mutations and denials. Frontend uses `RequirePermission` / `PermRoute` / `usePermission` for page-level guards. Sidebar is permission-aware, hiding menu items based on user roles and permissions. Backend routes have been hardened with `extractAuth` and `requireAuthed` for security.
- **Leaf-Account Enforcement:** Parent (header) accounts cannot be selected in any transactional UI; they are greyed out in comboboxes. Server-side validation `ensureLeafAccounts` prevents selection of non-leaf accounts and enforces multi-tenant integrity.
- **Centralized Sequence Management (مسلسل الحركات):** Admin-only module for managing and auditing transaction document numbers. A `sequences` table holds per-tenant counters bound to one or more transaction types (sales_invoice, sales_return, purchase_invoice, purchase_return, journal_entry, stock_*, vouchers, pos_receipt) with prefix, range, padding, current cursor, and capacity tracking. The `nextSequenceNumber(companyId, txType, ctx)` helper (in `artifacts/api-server/src/lib/sequences.ts`) locks the first active sequence with `SELECT ... FOR UPDATE`, formats `${prefix}${pad(n)}`, increments atomically, writes a `sequence_logs` row, and returns the formatted string — or `null` when no sequence is configured so callers fall back to legacy auto-numbering (non-breaking rollout). Wired into `journalEntries POST /`, `sales POST /sales-invoices`, and `purchasing POST /purchase-invoices`. Management UI at `/settings/sequences` provides CRUD, reset (admin-confirm with explicit reuse acknowledgement when used), bound-types badges, usage progress bar, and a logs drawer; permission key `sequences` under the dashboard group. **Numbering integrity guard:** once a sequence has issued at least one number (`currentNumber > startNumber`), the SHAPE-defining fields become server-side immutable — `prefix`, `startNumber`, and `padLength` cannot be changed; `currentNumber` may only be raised (never lowered); `endNumber` may only be raised. The frontend mirrors this contract: editing a used sequence shows a yellow "حقول مقفلة / Locked fields" banner, disables the locked inputs, blocks the delete action (deactivate instead), and requires a checkbox acknowledgement before a destructive reset on a used sequence (which sends `acknowledgeReuse: true` to the backend, otherwise the reset returns 409). **Concurrency hardening:** PATCH, RESET, and DELETE all run inside a single `db.transaction()` and acquire `SELECT ... FOR UPDATE` on the target row before validating, so they serialize cleanly with concurrent issuance from `nextSequenceNumber`. RESET writes its synthetic `__reset__` audit-log row atomically with the counter rewind. Verified end-to-end: 5 parallel journal-entry posts vs 5 parallel "lower currentNumber" PATCHes against the same sequence produced 5 unique sequential numbers and rejected every lowering attempt.
- **SuperAdmin Control Center Dashboard:** Single aggregated endpoint `GET /api/admin/dashboard` returns companies/users/subscriptions/backups/audit roll-ups computed by SQL `FILTER`-aware aggregates (no full-table loads), plus a 90-day company-signup timeline, plan distribution, missing-backup list, and a derived health-flag list (red/amber/green). The frontend page (`SuperAdminDashboard.tsx`) groups KPI tiles by category (Companies / Subscriptions / Activity & Health), renders the System Health card at the top with action links, charts the 90-day signups (Recharts BarChart) and plan distribution (Recharts donut), and exposes refreshed quick-link tiles to every SuperAdmin area. Refresh interval: 30s.
- **AI-Powered Data Import/Export Center:** Unified Settings module for admins to perform lossless export and arbitrary file import for 8 entities (accounts, customers, suppliers, items, warehouses, branches, cashBoxes, bankAccounts). Features AI mapping for import and transactional upsert with chunking.
- **Self-Aware System Auto-Discovery (SuperAdmin):** The AI System Repair screen (`/admin/ai-fix`) is now self-aware: a new SuperAdmin-only top section auto-discovers the entire system structure with no manual registration. Sources are reflective: API modules + endpoints come from source-file parsing of `routes/index.ts` and per-module route files (Express 5-safe; supports both `router.use("/x", v)` and `router.use(v)` forms); DB domains come from `pg_class`; frontend screens come from a recursive scan of `pages/**/*.tsx`; dashboard widgets come from regex over SuperAdmin pages (KPI labels, CardTitle, h1) — all scope-tagged (superadmin/tenant/shared) and scope-filtered. Two endpoints (`GET /api/admin/ai-fix/system-tree?scope=`, `POST /api/admin/ai-fix/system-summarize`) drive a UI with KPI tiles, collapsible category sections, refresh, and an AI-generated Arabic markdown analysis. Adding any new route, page, table, or widget appears in the screen automatically on the next request.

**System Design Choices:**
- **Modular Monorepo:** Promotes code reusability and separation of concerns.
- **Database Schema:** Designed for multi-tenancy and complex relationships.
- **API Design:** RESTful API with distinct routes for various modules.
- **Security:** JWTs, bcryptjs, and multi-tenant guards for data isolation.
- **AI Integration:** AI endpoints for suggesting accounts and data import mapping, with robust rule-based fallbacks.

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