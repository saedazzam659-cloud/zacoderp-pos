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
