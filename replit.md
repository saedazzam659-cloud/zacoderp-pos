# Overview

This project is a pnpm workspace monorepo providing a comprehensive Saudi ZATCA e-invoicing system. It supports multi-company operations with a bilingual (Arabic/English) RTL UI, designed to streamline financial operations, enhance reporting, and automate accounting processes in compliance with ZATCA regulations. Key capabilities include CSR generation, invoice submission (clearance and reporting), QR code generation, and detailed accounting reports. The system also integrates robust modules for inventory management, accounting, purchasing, and sales.

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
- **Authentication:** JWT-style Bearer tokens, single-session enforcement, real-time validation, bcryptjs for password hashing, and a dedicated SuperAdmin multi-layer login with advanced security features.
- **ZATCA Integration:** CSR generation (ECDSA secp256k1), APIs for compliance, production CSID onboarding, and invoice submission. QR code generation uses TLV binary encoding. XML generation adheres to UBL 2.1 ZATCA namespace.
- **Self-Registration:** Public registration flow creating pending companies and inactive admin users awaiting SuperAdmin approval, with country-specific compliance policies and dynamic module selection based on industry and plan.
- **Modules:**
    - **Inventory Management:** Tracks warehouses, items, stock, transfers, adjustments, and counts with Weighted Average costing and multi-unit support.
    - **Fiscal Periods:** Manages fiscal years and periods with status tracking and overlap detection.
    - **Sales Documents:** Includes `priceIncludesVat` flag, document-level discount implementation, and auto-application of promotions via a server-authoritative engine.
    - **Support System:** In-app ticket system.
    - **POS Management:** Monitors cashier shifts, links sales invoices to sessions, provides live KPIs, and manages POS terminals.
    - **Sequence Management:** Centralized, admin-only module for managing and auditing transaction document numbers with concurrent handling and per-branch counters.
- **Role-Based Access Control (RBAC) & Audit Log:** Granular per-module permissions, middleware for handler gating, and audit recording.
- **Account Management:** Enforcement of leaf accounts in transactional UIs and server-side validation.
- **Subscription Management:** Differentiated plans, lifecycle management, bulk actions, and auto-suspension for expired subscriptions.
- **Backup Operations:** SuperAdmin screen for backup health, manual/scheduled backups, and restore functionality.
- **Cross-Company Report Email Scheduling:** SuperAdmin Reports Hub allows weekly/monthly auto-emailing of selected cross-company CSV reports.
- **AI-Powered Features:** Voucher suggestions, data import/export with AI mapping, system auto-discovery for analysis, and a maintenance scheduler with 11 checks.
    - **Voice + AI Screen Actions:** A global "actionable assistant" panel lets users speak (Web Speech API, ar-SA / en-US) or type natural-language commands which the LLM converts into a sequence of `set_field` / `call_action` operations executed against the active screen. Built on a `ScreenActionsContext` registry that any form (currently `SalesDocumentForm`) can populate with its fields, actions and lookup tables; the backend `/api/ai/command` validates returned commands against the registered schema (lookup id existence, select option membership, type coercion). Includes race guards on screen navigation and graceful degradation when the AI is not configured.
    - **Production / Manufacturing:** Multi-tenant, branch-scoped manufacturing module with production orders (status workflow: draft → approved → in_production → quality_check → completed/cancelled), order line items (raw / product / byproduct), production resources (machines/lines/stations), and a full event timeline (`production_events`). Includes an embedded **AI Production Assistant** (`/api/ai/assist`) that explains screens, suggests next actions, and surfaces warnings; uses the existing OpenAI proxy with a deterministic AR/EN fallback so the panel always renders.
    - **Security & Monitoring (Phase 2 — AI Camera Analysis):** Security event records support image (≤5MB) and short video (≤25MB) attachments. Uploads go through a dedicated, ownership-tracked endpoint `POST /api/security-events/media/request-url` that records `(companyId, userId, objectPath, kind)` into a `security_event_media` table at presigned-URL issuance time. The vision endpoint `POST /api/ai/security/analyze-image` calls a vision model on the uploaded image and auto-fills the event type / severity / suggested title / description, but only after verifying the requested `/objects/...` path is owned by the caller's company in `security_event_media` (returns 404 otherwise to avoid leaking path existence). Write paths on `security_events` (POST/PUT) re-validate `imageUrl`/`videoClipUrl` against the same table so a foreign path can never be persisted. The events list shows 40×40 thumbnails with a click-to-lightbox preview.

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