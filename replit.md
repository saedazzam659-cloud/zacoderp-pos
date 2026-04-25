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
- **Modules:**
    - **Inventory Management:** Tracks warehouses, items, stock balance, ledger, transfers, adjustments, and counts using Weighted Average costing and multi-unit support.
    - **Fiscal Periods:** Manages fiscal years and periods, including status tracking, auto-splitting, and overlap detection.
    - **Sales Documents:** `priceIncludesVat` flag and document-level discount implementation.
    - **Support System:** In-app ticket system with admin replies.
    - **POS Management:** Monitors cashier shifts, links sales invoices to sessions, provides live KPIs, and manages POS terminals.
    - **Sequence Management:** Centralized, admin-only module for managing and auditing transaction document numbers with concurrent handling and integrity guards.
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