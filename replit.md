# Overview

This project is a pnpm workspace monorepo using TypeScript, focused on developing a comprehensive Saudi ZATCA e-invoicing system. It supports multi-company operations, features a bilingual (Arabic/English) RTL UI, and aims to provide a robust solution for various business functions including invoicing, inventory management, accounting, purchasing, and sales, all while ensuring compliance with ZATCA regulations.

The system is designed to streamline financial operations, enhance reporting capabilities, and automate complex accounting processes, offering significant market potential for businesses operating in Saudi Arabia. Key capabilities include ZATCA integration for CSR generation, invoice submission (clearance and reporting), QR code generation, and detailed accounting reports.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

# System Architecture

The system is built as a pnpm workspace monorepo, leveraging Node.js 24 and TypeScript 5.9.

**UI/UX Decisions:**
The frontend uses React with Vite and TailwindCSS, supporting a multi-company, Arabic/English RTL interface. Design templates for invoices (Classic, Modern, Professional, Colored, Compact) are provided, ensuring a consistent and professional appearance. Logo uploads and decimal place settings are customizable per company.

**Technical Implementations:**
- **Monorepo Tool:** pnpm workspaces for efficient dependency management.
- **API Framework:** Express 5 handles API routing and logic.
- **Database:** PostgreSQL with Drizzle ORM for data persistence.
- **Validation:** Zod (`zod/v4`) and `drizzle-zod` for robust data validation.
- **API Codegen:** Orval generates API hooks and Zod schemas from an OpenAPI specification.
- **Build System:** esbuild for CJS bundle generation.
- **Authentication:** JWT-style Bearer tokens stored in localStorage, with single-session enforcement and real-time session validation. Password hashing is done using bcryptjs (12 rounds).
- **ZATCA Integration:**
    - CSR generation uses ECDSA secp256k1 with ZATCA-specific OIDs.
    - APIs for compliance, production CSID onboarding, and invoice submission (clearance/reporting).
    - QR code generation uses TLV binary encoding (Tags 1-5) rendered via `qrcode.react`.
    - XML generation adheres to UBL 2.1 full ZATCA namespace, including invoice hash chaining and counter tracking.
- **Subscription Plans:** Differentiated plans (Starter, Professional, Enterprise) based on users and invoice limits.
- **Menu Permissions:** A flexible system allowing superadmins to toggle menu visibility per company, stored as JSON in the `companies.menuPermissions` column.
- **Inventory Management Module:**
    - Comprehensive inventory tracking including warehouses, item groups, units, items, stock balance, ledger, transfers, adjustments, and counts.
    - Costing method: Weighted Average.
    - Multi-unit per item support with conversion factors and pricing.
    - Stock Transfer and Adjustment modules include auto Journal Entry generation and AI-powered account suggestions.
- **Fiscal Periods Module:** Manages fiscal years and periods with status tracking (open, closed, permanently_closed), including auto-splitting of years into monthly periods and overlap detection.
- **Sales Document Enhancements:**
    - **Tax-Inclusive Pricing:** `priceIncludesVat` flag on sales documents to handle VAT calculation dynamically, recomputing line totals instantly.
    - **Document-Level Discount:** Implemented across sales invoices, quotations, and purchase invoices/returns, with percentage and amount inputs and server-side clamping.
- **Voucher AI Suggestions:** AI-powered suggestions for counterparty accounts in Receipt and Payment Vouchers, leveraging entity type, linked accounts, keywords, and amount to select appropriate accounts (assets, liabilities, revenue, expenses).

**System Design Choices:**
- **Modular Monorepo:** Promotes code reusability and separation of concerns.
- **Database Schema:** Designed to support multi-tenancy and the complex relationships between companies, users, invoices, inventory, and accounting entities. Key tables include `companies`, `customers`, `invoices`, `users`, `subscriptions`, `suppliers`, `accounts`, `inventory_items`, `warehouses`, `fiscal_years`, `fiscal_periods`, `sales_invoices`, `sales_quotations`, `stock_transfers`, `stock_adjustments`.
- **API Design:** RESTful API with distinct routes for various modules like `/auth`, `/companies`, `/customers`, `/invoices`, `/dashboard`, `/inventory`, `/accounts`, and `/fiscal`.
- **Security:** JWTs for authentication, bcryptjs for password hashing, and multi-tenant guards (`assertCompanyOwned()`) to ensure data isolation.
- **AI Integration:** AI endpoints for suggesting accounts in inventory transfers, adjustments, receipt vouchers, and payment vouchers, with robust rule-based fallbacks.

# Recent Changes

**Notification Dismiss / Auto-Clear UX (April 2026)**
- New `notification_dismissals` table (per-user soft-delete: `(notification_id, user_id, dismissed_at)`). Both list/count queries and the bell dropdown now LEFT-JOIN-and-filter dismissals so a hidden notification disappears for that user only — broadcast notifications stay visible to other recipients.
- New endpoints: `DELETE /api/notifications/:id` (dismiss for the caller, idempotent), `POST /api/notifications/:id/restore` (undo), `DELETE /api/notifications/cleanup/read` (bulk-dismiss every notification this user has already read; returns the dismissed ids so the UI can offer a single Undo).
- Page `/notifications`: each card has an X (dismiss) button on the right. Cards can also be **drag-to-dismiss** (mouse + touch — beyond ~35% of the card width snaps out). After a user clicks "تعليم كمقروء" a small purple banner appears at the bottom of the card with a 5-second countdown ring around the X plus an "إيقاف" button — if not stopped, the card auto-clears with a Toast undo. Header gets a "تنظيف المقروء (N)" button that bulk-dismisses every read item with a single Undo toast that restores all of them.
- Bell dropdown also gets a small X-on-hover for inline dismissal with the same Undo Toast.

**Support Messages System (April 2026)**
- New `support_messages` table (id, companyId, userId, senderName, companyName, subject, body, priority, status, adminReply, adminReplyAt, resolvedAt, resolvedByUserId) and `support_settings` singleton table for delivery channels (in-app / webhook URL+secret / Telegram bot+chat).
- New API router `/api/support-messages`: POST `/` (any user creates a ticket), GET `/mine` (own history), GET `/` & `/stats` (superadmin inbox + counts), PATCH `/:id` (superadmin updates status/reply — auto-creates a `support_reply` notification for the original sender), `_settings/get|update|test` (superadmin only; secrets are masked in responses, only updated when caller sends a non-masked value).
- Dispatch flow on a new ticket fans out to (1) in-app notification per superadmin user, (2) JSON POST to a configured webhook (Slack/Discord/Zapier/n8n compatible, optional `X-Support-Secret` header), (3) Telegram via bot API. Each channel is independently togglable.
- ERP UI: `SupportMessageCard` mounted at the bottom of the company dashboard (subject + body + priority selector + history). Superadmin pages `/admin/support` (inbox with status filter, expand-to-reply, status changes) and `/admin/support-settings` (channel toggles, secrets, test-send button). Sidebar entries `nav.supportInbox` / `nav.supportSettings` added under the superadmin group.

**POS Monitoring (April 2026)**
- New `pos_sessions` table tracks every cashier shift (open/closed/force_closed) with opening/closing/expected cash and difference.
- Added `pos_session_id` and `created_by_id` columns to `sales_invoices` so each POS sale is linked to its session and operator.
- New API router `/api/pos-sessions` (open / close / current / list / detail / summary). Hard-gated to authenticated users; tenant-isolated by `companyId`. Force-close requires same-company match for non-superadmin admins; sales POST validates that any provided `posSessionId` belongs to the caller's company and is open before linking.
- POS app: opens a session on login (or reuses the user's existing open one), passes `posSessionId` on each invoice create, and closes the session on logout.
- ERP page `/pos-monitoring` (Arabic, RTL) shows live KPIs (open sessions, today's POS sales, invoice count, sessions closed today), an active-sessions strip with auto-refresh every 10 s, top-cashier ranking, a filterable sessions table, and a per-session detail dialog with all linked invoices and a force-close action. Menu entry `nav.posMonitoring` added in the Company Business group.
- Note: route is `/pos-monitoring` (not `/pos/monitoring`) because `/pos/*` is reserved for the POS artifact preview path in the proxy.

# External Dependencies

- **pnpm:** Monorepo package manager.
- **Node.js:** Runtime environment.
- **TypeScript:** Programming language.
- **Express:** Web application framework for the API server.
- **PostgreSQL:** Relational database.
- **Drizzle ORM:** Object-Relational Mapper for database interaction.
- **Zod:** Schema declaration and validation library.
- **drizzle-zod:** Integration between Drizzle ORM and Zod.
- **Orval:** OpenAPI client code generator.
- **esbuild:** Bundler for JavaScript and TypeScript.
- **React:** JavaScript library for building user interfaces.
- **Vite:** Next-generation frontend tooling.
- **TailwindCSS:** Utility-first CSS framework.
- **React Query:** Data-fetching library for React.
- **bcryptjs:** Library for hashing passwords.
- **qrcode.react:** React component for QR code generation.
- **openssl:** Used for CSR generation for ZATCA integration.