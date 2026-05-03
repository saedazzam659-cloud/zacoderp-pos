# Overview

This project is a pnpm workspace monorepo providing a comprehensive Saudi ZATCA e-invoicing system. It aims to optimize financial operations, automate accounting processes, and ensure ZATCA compliance for multi-company businesses. Key capabilities include CSR generation, invoice submission (clearance and reporting), QR code generation, detailed accounting reports, and integrated modules for inventory, accounting, purchasing, and sales. The system is designed to enhance financial reporting accuracy and operational efficiency for businesses in Saudi Arabia.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

# System Architecture

The system is built as a pnpm workspace monorepo, utilizing Node.js and TypeScript.

## UI/UX Decisions
The frontend uses React with Vite and TailwindCSS, supporting bilingual (Arabic/English) RTL interfaces and multi-company operations. It includes customizable invoice templates, logo uploads, and per-company decimal settings.

## Technical Implementations
- **Monorepo:** Managed using pnpm workspaces.
- **API:** Developed with Express.js; uses Orval for API hook and Zod schema generation.
- **Database:** PostgreSQL with Drizzle ORM.
- **Validation:** Zod and `drizzle-zod` for data validation.
- **Authentication:** JWT-style Bearer tokens, single-session enforcement, real-time validation, bcryptjs for password hashing, and SuperAdmin multi-layer login.
- **ZATCA Integration:** Handles CSR generation (ECDSA secp256k1), compliance/production CSID onboarding, invoice submission, TLV binary encoded QR codes, and UBL 2.1 ZATCA XML generation.
- **Self-Registration:** Supports public registration with SuperAdmin approval, country-specific compliance, and dynamic module selection.
- **Soft-Delete Recycle Bin:** Provides soft-delete for companies, with restore and permanent purge options.
- **Core Modules:** Inventory Management (warehouses, items, stock, transfers, adjustments, counts, Weighted Average costing, multi-unit), Fiscal Periods, Sales Documents, Quotation to Invoice Linking, Account Statement Drill-down, In-app Support System, POS Management, Sequence Management, Financial Transactions, Receipt/Payment Vouchers, and a Contracting Module.
- **Role-Based Access Control (RBAC) & Audit Log:** Granular permissions and comprehensive audit trail.
- **Branch-Level Data Isolation:** Users with `view_all_branches=false` and a `user_branches` assignment are scoped to their branches across `/api/org/branches`, `/api/cash-boxes`, `/api/bank-accounts`, and `/api/inventory/warehouses`. NULL branchId rows are treated as shared (visible to all) for reads, but writes/deletes on shared rows are admin-only. Warehouses gained a nullable `branch_id` column with full POST/PUT/DELETE branch authorization (cross-company branchId rejected; restricted users cannot create/move shared warehouses).
- **AI-Powered Features:** Incorporates Voice + AI Screen Actions, AI Production Assistant, AI Security Event Analysis, Real-time Security Alerts, In-App Inbox + AI Reports, SEO Connection AI Suggestion, and AI-assisted Tax Entry on Journal Entry Forms.
- **Entity Account Auto-Creation:** Automatically creates posting sub-accounts for entities like cashbox, bank, customer, supplier, and warehouse.
- **Company Logo on Print Surfaces:** Configured company logo renders on all print and PDF outputs.
- **Per-Device Preferred Printer & Form Print Buttons:** Allows devices to save preferred printers via localStorage and supports WebUSB for auto-detection in Chromium browsers. Print buttons provide immediate print actions.
- **Deep-Link Auth Redirect:** Redirects logged-out users attempting to access protected URLs to the login page with a redirect parameter.
- **Shared Audit-Grid Library:** Standardized grid primitives for audit/journal listing screens, including column reordering, resizing, filtering, pagination, CSV export with formula-injection defense, and LocalStorage persistence.
- **Item Card PRO Extensions:** Enhancements including Item Variants, Bundles/Kits, Item Suppliers, AI Assist for fields, Tags & Smart Search, QR Code generation, Internal Audit Log for items, Item Image uploads, Per-Item Default Discount, Multi-Unit Pricing, Performance Analytics, Smart Stock Alerts, Bulk Label Printing, Scan Barcode → Attach Image, Multi-currency Override Prices (per item, per non-default currency), Per-Branch Stock & Thresholds, Smart Reorder Suggestion (lead-time + velocity formula), BOM Manufacturing Steps (labor + overhead totals), and Auto Low-Stock Notifications (idempotent per-day broadcast via partial unique index on `(company_id, source_key)`).
- **Sales Reports Hub:** Centralised landing for daily / period / returns / payment-mix sales reports. The **Payment-Mix Sales Report** (`/sales/reports/payment-mix`) breaks down a single day's sales and receipts by payment method (cash, bank/card, credit, etc.), shows hourly distribution, per-branch and per-customer slices, and exposes a "Analyse with AI" CTA that calls a separate `POST /api/sales-analytics/payment-mix-report/ai-insights` endpoint (model `gpt-5.4` via the Replit AI proxy) to return a JSON `{headline, highlights, concerns, recommendation}` payload rendered as a structured insights card. Tenant-scoped, branch-scoped, fully RTL/i18n.
- **Realtime Session Sync (SSE):** SuperAdmin changes to a tenant's subscription (license limits, plan, dates, freeze/activate, bulk actions) and to a tenant's company state (approve/reject/restore, per-user role/active toggle) propagate to that tenant's logged-in users within ~1s instead of waiting for the 10s `/auth/me` poll. Implementation: an in-process `EventEmitter` (`api-server/src/lib/sessionEvents.ts`) is fed by ten emit call-sites in `admin.ts` and drained by `GET /api/realtime/session-events` (mounted before `zatcaRouter`'s global auth gate so the SSE route can authenticate via its own `?token=` query param — `EventSource` cannot send custom headers). Server-side filter restricts events by `companyId` (SuperAdmin receives all). The client `AuthContext` opens one EventSource per session, listens for `subscription_changed`/`company_changed`/`permissions_changed` events, then re-runs `checkSession()` and `qc.invalidateQueries()` so cached pages re-fetch with the new limits. Heartbeat every 25s keeps proxies from dropping the stream; client uses exponential backoff (1s → 30s) on disconnect.

## System Design Choices
- **Modular Monorepo:** For code reusability and separation of concerns.
- **Database Schema:** Optimized for multi-tenancy and complex transactional relationships.
- **API Design:** Adheres to RESTful principles.
- **Security:** Robust mechanisms including JWTs, bcryptjs, and multi-tenant guards.
- **AI Integration:** Strategic AI integration for suggestions, data processing, and analysis, with rule-based fallbacks.

# External Dependencies

- **pnpm:** Monorepo package manager.
- **Node.js:** JavaScript runtime environment.
- **TypeScript:** Superset of JavaScript.
- **Express.js:** Web application framework.
- **PostgreSQL:** Relational database system.
- **Drizzle ORM:** Object-Relational Mapper.
- **Zod:** Schema declaration and validation library.
- **drizzle-zod:** Drizzle ORM and Zod integration.
- **Orval:** OpenAPI client code generator.
- **React:** Frontend JavaScript library.
- **Vite:** Frontend build tool.
- **TailwindCSS:** Utility-first CSS framework.
- **bcryptjs:** Password hashing library.
- **openssl:** Used for CSR generation.
- **OpenAI:** Provides AI services.
- **xlsx (SheetJS):** For parsing and generating Excel/CSV files.
- **qrcode.react:** For QR code generation.
- **jsbarcode:** For barcode generation (Code128).
- **html5-qrcode:** For camera-based barcode scanning.

## Internal Chat Module (Phase 1)
Real-time text messaging between company colleagues, scoped per tenant (companyId on conversations and messages). Tables: `chat_conversations`, `chat_participants` (with `last_read_message_id` for read receipts), `chat_messages` (with soft-delete via `deleted_at`). Direct (1:1) and group conversations supported; direct chats are auto-deduped.

REST under `/api/chat/*` (list/create conv, list/send messages with `?since=&before=` cursors, /read marker, DELETE soft, /unread-count, /users) and `/api/chat-ai/*` (summarize, suggest-replies, translate ar↔en, extract-tasks, transcribe-stub→503, ILIKE search). Real-time delivery via React Query polling (3s for active conversation, 10s for the list) — Socket.io upgrade is deferred. Attachments use the existing presigned upload flow (`/api/storage/uploads/request-url`).

UI: `/chat` — sidebar of conversations + message panel + composer (file/image attach, Enter-to-send) + AI tools side-sheet (Sparkles button) hosting all six AI features. Permission-gated by the `chat` module key (admins bypass). Sidebar nav entry under "أدوات الذكاء الاصطناعي" with green theme. AI calls go through the OpenAI integrations proxy (gpt-5.4, max_completion_tokens, response_format JSON for structured outputs); endpoints fall back to rule-based responses when the proxy is unavailable and report `source: "ai"|"rule"` honestly.

## Online Store Module
- DB tables (lib/db/src/schema/onlineStore.ts): `stores`, `store_domains`, `store_products` (FK→items), `store_orders` (FK→invoices SET NULL), `store_order_items`, `store_payment_settings`. Auto-created via ensureSchema.ts.
- Backend: `/api/online-store/*` (CRUD + transactional `POST /orders/:id/confirm` → creates ZATCA invoice STR-{code} with 15% VAT) and `/api/online-store-ai/*` (sales-analysis, recommend-products, low-stock, generate-description; OpenAI gpt-5.4 with deterministic fallbacks).
- Frontend: `artifacts/zatca-invoicing/src/pages/online-store/OnlineStore.tsx` with 6 tabs (Dashboard/Products/Orders/Domains/Payments/AI). Route `/online-store` gated by permission key `online_store`.
- Multi-tenant: every table has `company_id` with cascade; routes use `getCid()` for isolation; mutations require admin.
- Deferred: customer-facing storefront artifact, real payment-gateway integrations, DNS/SSL automation.