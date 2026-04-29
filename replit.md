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