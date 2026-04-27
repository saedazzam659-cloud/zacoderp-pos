# Overview

This project is a pnpm workspace monorepo designed to provide a comprehensive Saudi ZATCA e-invoicing system. Its primary purpose is to streamline financial operations, automate accounting, and ensure compliance with ZATCA regulations for multi-company operations. Key capabilities include CSR generation, invoice submission (clearance and reporting), QR code generation, detailed accounting reports, and robust modules for inventory, accounting, purchasing, and sales. The system aims to enhance financial reporting and operational efficiency for businesses in Saudi Arabia.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

# System Architecture

The system is built as a pnpm workspace monorepo, utilizing Node.js and TypeScript.

**UI/UX Decisions:**
The frontend employs React with Vite and TailwindCSS to deliver a bilingual (Arabic/English) RTL interface that supports multi-company operations. It features customizable invoice design templates, logo uploads, and per-company decimal place settings.

**Technical Implementations:**
- **Monorepo:** Managed with pnpm workspaces for modularity.
- **API:** Developed with Express.js, using Orval for API hook and Zod schema generation from OpenAPI specifications.
- **Database:** PostgreSQL with Drizzle ORM for data persistence.
- **Validation:** Utilizes Zod and `drizzle-zod` for robust data validation.
- **Authentication:** Implements JWT-style Bearer tokens, single-session enforcement, real-time validation, and bcryptjs for password hashing. Includes a SuperAdmin multi-layer login with advanced security.
- **ZATCA Integration:** Handles CSR generation (ECDSA secp256k1), APIs for compliance and production CSID onboarding, and invoice submission. QR codes are generated using TLV binary encoding, and XML generation adheres to UBL 2.1 ZATCA namespace.
- **Self-Registration:** Supports a public registration flow for new companies and inactive admin users, with SuperAdmin approval, country-specific compliance, and dynamic module selection.
- **Core Modules:**
    - **Inventory Management:** Comprehensive tracking of warehouses, items, stock, transfers, adjustments, and counts, including Weighted Average costing and multi-unit support.
    - **Fiscal Periods:** Manages fiscal years and periods with status tracking and overlap detection.
    - **Sales Documents:** Features `priceIncludesVat` flag, document-level discount, and server-authoritative promotion application.
    - **Quotation to Invoice Linking:** Allows direct conversion of accepted quotations into sales invoices with atomic updates to ensure data integrity.
    - **Account Statement Drill-down:** Provides clickable links in account statements to navigate directly to source documents or journal entries.
    - **Support System:** In-app ticket management.
    - **POS Management:** Tools for monitoring cashier shifts, linking sales invoices to sessions, live KPIs, and terminal management.
    - **Sequence Management:** Centralized administration and auditing of transaction document numbers with concurrent handling and per-branch counters.
- **Role-Based Access Control (RBAC) & Audit Log:** Granular permissions per module, middleware for access control, and audit trail recording.
- **Work Sessions (Login Activity Tracker):** Tracks user login activity, enforces single active sessions, and allows users to generate activity reports.
- **Manual Sessions (Admin-Managed Work Shifts):** Admin-defined work shifts assignable to users, with `x-session-id` HTTP header validation.
- **Account Management:** Enforces leaf accounts in transactional UIs and server-side validation.
- **Subscription Management:** Manages differentiated plans, subscription lifecycles, bulk actions, and auto-suspension.
- **Backup Operations:** SuperAdmin interface for backup health, manual/scheduled backups, and restore.
- **Cross-Company Report Email Scheduling:** SuperAdmin functionality to auto-email selected cross-company CSV reports weekly/monthly.
- **AI-Powered Features:** Includes voucher suggestions, data import/export with AI mapping, system auto-discovery for analysis, and a maintenance scheduler.
    - **Voice + AI Screen Actions:** A global actionable assistant panel enabling natural-language commands (voice/text) to execute `set_field` / `call_action` operations on active screens.
    - **AI Production Assistant:** Embedded assistant in the multi-tenant manufacturing module, providing explanations, next-action suggestions, and warnings.
    - **AI Security Event Analysis:** Integration for analyzing uploaded images and videos from security events to auto-fill event details.
    - **Real-time Security Alerts + Notification Rules:** Configurable rules for security events to trigger in-app notifications and broadcasts.
    - **In-App Inbox + AI Reports:** A persistent inbox for messages and AI-generated reports (e.g., sales summaries) delivered with attachments and HTML summaries, with strict JSON validation for AI prompts.

**System Design Choices:**
- **Modular Monorepo:** Facilitates code reuse and clear separation of concerns.
- **Database Schema:** Designed for multi-tenancy and complex transactional relationships.
- **API Design:** Adheres to RESTful principles with well-defined routes.
- **Security:** Robust security mechanisms including JWTs, bcryptjs, and multi-tenant guards.
- **AI Integration:** Strategic integration of AI for suggestions, data processing, and analysis, with rule-based fallbacks for reliability.

# External Dependencies

- **pnpm:** Monorepo package manager.
- **Node.js:** JavaScript runtime.
- **TypeScript:** Superset of JavaScript.
- **Express.js:** Web application framework.
- **PostgreSQL:** Relational database.
- **Drizzle ORM:** Object-Relational Mapper.
- **Zod:** Schema declaration and validation.
- **drizzle-zod:** Integration between Drizzle ORM and Zod.
- **Orval:** OpenAPI client code generator.
- **React:** Frontend library.
- **Vite:** Frontend build tool.
- **TailwindCSS:** Utility-first CSS framework.
- **bcryptjs:** Password hashing.
- **openssl:** Used for CSR generation.
- **OpenAI:** AI services for suggestions and validations.
- **xlsx (SheetJS):** Library for Excel/CSV parsing and generation.
## Contracting Module — Owner & Subcontractor Contracts (Apr 2026)

The Contracting module now distinguishes formal contracts from progress
billing:

- **Owner contract** (`contracting_owner_contracts`) — the master agreement
  between the company and its client (المالك). One main contract per
  project plus N change orders. Captures value, advance, retention %, VAT %,
  duration, signed date, status, and free-text scope/payment/penalty
  clauses. Routes: `GET/POST /api/contracting/projects/:projectId/owner-contracts`,
  `PUT/DELETE /api/contracting/owner-contracts/:id`.

- **Sub contract** (`contracting_sub_contracts`) — agreement we sign with a
  sub-contractor for a specific scope of work. `contractorId` required
  (FK to `contracting_contractors`). Routes: `GET/POST /api/contracting/projects/:projectId/sub-contracts`,
  `PUT/DELETE /api/contracting/sub-contracts/:id`.

- **Progress bills** (`contracting_progress_bills`) now carry a
  `direction` column:
  - `outgoing` — claims our company issues to the owner (linked optionally
    to an owner contract).
  - `incoming` — claims sub-contractors submit to us (linked to a
    contractor + sub contract). `contractorId` is required at create time
    AND on update (direction is immutable).
  Bills also persist `vatPercent` per row so editing a non-15% bill no
  longer silently rewrites its tax to 15%, and persist `paidAmount` so the
  dashboard can show outstanding vs paid.
  Filter via `?direction=outgoing|incoming` on the list endpoint.

All new POST/PUT routes validate every cross-table FK reference
(`projectId`, `contractorId`, `customerId`, `ownerContractId`,
`subcontractorContractId`) belongs to the caller's `companyId` to prevent
cross-tenant data leakage. The frontend project detail page (`ContractingProjectDetail.tsx`)
exposes two new tabs (`عقد المالك`, `عقود الباطن`) and the bills tab now
splits into outgoing/incoming sub-tabs with totals header.
