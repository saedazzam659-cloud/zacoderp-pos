# Overview

This project is a pnpm workspace monorepo designed to provide a comprehensive Saudi ZATCA e-invoicing system. Its primary goal is to optimize financial operations, automate accounting processes, and ensure ZATCA compliance for multi-company businesses. The system offers features such as CSR generation, invoice submission (clearance and reporting), QR code generation, detailed accounting reports, and integrated modules for inventory, accounting, purchasing, and sales. It aims to significantly improve financial reporting accuracy and operational efficiency for businesses operating in Saudi Arabia.

# User Preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

# System Architecture

The system is built as a pnpm workspace monorepo, utilizing Node.js and TypeScript.

## UI/UX Decisions
The frontend employs React with Vite and TailwindCSS, supporting a bilingual (Arabic/English) RTL interface and multi-company operations. It includes features like customizable invoice templates, logo uploads, and per-company decimal place settings.

## Technical Implementations
- **Monorepo:** Managed using pnpm workspaces for efficient development.
- **API:** Developed with Express.js; uses Orval for API hook and Zod schema generation.
- **Database:** PostgreSQL is used as the relational database, integrated with Drizzle ORM.
- **Validation:** Zod and `drizzle-zod` are used for robust data validation.
- **Authentication:** Implements JWT-style Bearer tokens, single-session enforcement, real-time validation, bcryptjs for password hashing, and SuperAdmin multi-layer login.
- **ZATCA Integration:** Handles CSR generation (ECDSA secp256k1), compliance/production CSID onboarding, invoice submission, TLV binary encoded QR codes, and UBL 2.1 ZATCA XML generation.
- **Self-Registration:** Supports a public registration flow for new companies and inactive admin users, with SuperAdmin approval, country-specific compliance, and dynamic module selection.
- **Soft-Delete Recycle Bin:** Provides soft-delete functionality for companies, including restore and permanent purge options.
- **Core Modules:** Includes Inventory Management (warehouses, items, stock, transfers, adjustments, counts, Weighted Average costing, multi-unit), Fiscal Periods, Sales Documents (`priceIncludesVat`, document-level discounts, server-authoritative promotion), Quotation to Invoice Linking, Account Statement Drill-down, In-app Support System, POS Management (cashier shifts, KPIs, terminal management), Sequence Management, Financial Transactions, Receipt Vouchers, Payment Vouchers, and a Contracting Module.
- **Role-Based Access Control (RBAC) & Audit Log:** Granular permissions and comprehensive audit trail.
- **AI-Powered Features:** Incorporates Voice + AI Screen Actions, AI Production Assistant, AI Security Event Analysis, Real-time Security Alerts, In-App Inbox + AI Reports, SEO Connection AI Suggestion, and AI-assisted Tax Entry on Journal Entry Forms.
- **Entity Account Auto-Creation:** Automatically creates posting sub-accounts for cashbox, bank, customer, supplier, and warehouse entities when not explicitly chosen by the user. The parent accounts are configurable via the Account Mapping screen.
- **Company Logo on Print Surfaces:** The configured company logo is rendered on all print and PDF outputs across the system, with security measures in place to prevent XSS vulnerabilities.
- **Per-Device Preferred Printer & Form Print Buttons:** Print Settings now lets each device save a preferred printer name (localStorage) with an instant test-sheet action and an "اكتشاف تلقائي" (auto-detect) button that uses WebUSB (`navigator.usb.requestDevice`, USB printer class 7) to pre-fill the printer name from a USB-connected printer in Chromium-based browsers. Every form that has a print template (sales invoices/quotations/orders, receipt vouchers, payment vouchers, journal entries, customer/supplier settlements) shows a dedicated "طباعة" button beside Save; popup-blocked print windows surface a clear toast instead of silently failing.
- **Deep-Link Auth Redirect:** Opening a protected in-app URL (e.g. `/accounting`, `/invoices/...`, `/inventory/...`) in a fresh browser tab while logged out now redirects to `/login?redirect=<encoded path>` instead of the custom 404. Login.tsx reads the `redirect` query param on success (with an open-redirect guard — must start with a single `/`, no `//`, no `://`) and navigates the user to their original destination across all auth paths (credentials, OTP, recovery code). Truly unknown URLs (random typos / SEO crawler probes that aren't in the protected-prefix allow-list) still render the in-app 404 so search engines continue to see a 404 for non-existent pages.
- **Shared Audit-Grid Library (`src/lib/auditGridLayout.ts` + `src/components/auditGrid/AuditGridControls.tsx`):** All "audit / journal" listing screens (sales journal, customer settlements, journal entries, sales returns) now share one set of grid primitives: 8 header palettes × 8 footer palettes, column reorder, Excel-style column resize, per-column filters (text + numeric `>=N` / `<N` / `=N` syntax via `matchCol`), pagination with "show all", totals row in `tfoot`, CSV export with **CSV-formula-injection defense** (cells starting with `= + - @ TAB CR` are prefixed with `'`), and per-tenant LocalStorage persistence (`<screenSlug>.layout.v1.c<companyId>`). The hook clears `colFilters` on tenant switch so a previous tenant's filters don't silently hide rows in the new tenant view.
- **Item Card PRO Extensions (rolling out in batches):** A 20-feature enhancement plan for the Items master screen. Shipped: **#12 AI Assist** (per-field GPT suggestions with checkbox-pick + apply), **#4 Tags & Smart Search** (new `items.tags` text column, chip-style TagsInput, dedupe/normalization on POST/PUT, list-page filter extended to match tags, AI-suggested tags merge with existing user tags), **#11 QR Code** (per-item QR via `qrcode.react` using barcode/code/id, locale-aware preview dialog, XSS-safe print sticker built via DOM APIs with `noopener,noreferrer`).

## System Design Choices
- **Modular Monorepo:** Designed for code reusability and clear separation of concerns.
- **Database Schema:** Optimized for multi-tenancy and complex transactional relationships.
- **API Design:** Adheres to RESTful principles for consistency and ease of use.
- **Security:** Robust security mechanisms including JWTs, bcryptjs, and multi-tenant guards.
- **AI Integration:** Strategic AI integration for suggestions, data processing, and analysis, with rule-based fallbacks for reliability.

# External Dependencies

- **pnpm:** Monorepo package manager.
- **Node.js:** JavaScript runtime environment.
- **TypeScript:** Superset of JavaScript.
- **Express.js:** Web application framework.
- **PostgreSQL:** Relational database system.
- **Drizzle ORM:** Object-Relational Mapper for PostgreSQL.
- **Zod:** Schema declaration and validation library.
- **drizzle-zod:** Integration between Drizzle ORM and Zod.
- **Orval:** OpenAPI client code generator.
- **React:** Frontend JavaScript library.
- **Vite:** Frontend build tool.
- **TailwindCSS:** Utility-first CSS framework.
- **bcryptjs:** Library for password hashing.
- **openssl:** Used for CSR generation.
- **OpenAI:** Provides AI services.
- **xlsx (SheetJS):** Library for parsing and generating Excel/CSV files.