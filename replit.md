# Overview

This project is a pnpm workspace monorepo using TypeScript, focused on developing a comprehensive Saudi ZATCA e-invoicing system. It supports multi-company operations, features a bilingual (Arabic/English) RTL UI, and aims to provide a robust solution for various business functions including invoicing, inventory management, accounting, purchasing, and sales, all while ensuring compliance with ZATCA regulations. The system is designed to streamline financial operations, enhance reporting capabilities, and automate complex accounting processes, offering significant market potential for businesses operating in Saudi Arabia. Key capabilities include ZATCA integration for CSR generation, invoice submission (clearance and reporting), QR code generation, and detailed accounting reports.

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
- **Inventory Management Module:** Comprehensive tracking including warehouses, items, stock balance, ledger, transfers, adjustments, and counts. Costing method: Weighted Average. Multi-unit per item support. Stock Transfer and Adjustment modules include auto Journal Entry generation and AI-powered account suggestions.
- **Fiscal Periods Module:** Manages fiscal years and periods with status tracking, auto-splitting into monthly periods, and overlap detection.
- **Sales Document Enhancements:** `priceIncludesVat` flag for dynamic VAT calculation and document-level discount implementation.
- **Voucher AI Suggestions:** AI-powered suggestions for counterparty accounts in Receipt and Payment Vouchers.
- **Support Messages System:** In-app support ticket system with admin replies, configurable delivery channels (in-app notifications, webhooks, Telegram), and superadmin inbox.
- **POS Monitoring:** Tracks cashier shifts (open/closed), links sales invoices to sessions, and provides live KPIs, active session monitoring, and cashier ranking.
- **POS Terminals (طرق البيع / المحطات):** Admin-managed POS stations that link a branch to a specific physical machine (auto-paired by `localStorage.pos_device_id` on first cashier login) and optionally a cash box. Cashier login is a 2-stage wizard: credentials → branch+terminal picker. Session opening is wrapped in a DB transaction with `SELECT … FOR UPDATE` on the terminal row, preventing two cashiers from grabbing the same station and two devices from racing to claim an unpaired terminal. All mutating endpoints (`POST/PATCH/DELETE/unpair`) require `admin` or `superadmin` role; cross-tenant `branchId`/`cashBoxId` linkage is rejected.

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
- **OpenAI:** For AI-powered suggestions and validations (e.g., Journal Entry Validation).