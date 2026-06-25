# ZATCA e-invoicing System

A comprehensive Saudi ZATCA e-invoicing platform for multi-company businesses: financial operations, automated accounting, and ZATCA compliance. Bilingual (Arabic/English) RTL.

> Deep implementation notes live in `.agents/memory/` (indexed by `MEMORY.md`) and in the code. This file is a high-level map + durable rules only — keep it lean.

## Stack

- React + Vite (frontend), Express.js (backend), Node.js/TypeScript
- Drizzle ORM, Zod + `drizzle-zod` validation, TailwindCSS
- pnpm monorepo (see `pnpm-workspace` skill)

## Where things live

- `lib/db/src/schema/`: Drizzle schema definitions.
- `artifacts/zatca-invoicing/src/pages/`: web frontend pages.
- `artifacts/api-server/src/routes/`: API endpoints.
- `artifacts/api-server/src/middleware/auth.ts`: `resolveCompanyId`, `branchScopeSpread`, RBAC.
- `artifacts/api-server/src/lib/sessionEvents.ts`: realtime SSE emitter.
- `artifacts/pos-desktop/`: offline Tauri Windows POS (separate from web POS `artifacts/pos/`).

## Product

- ZATCA e-invoicing (CSR, CSID, UBL 2.1 XML, TLV QR), customizable templates, logo upload, per-company decimals
- Multi-company + RBAC, audit log, self-registration, SuperAdmin multi-layer login
- Inventory (warehouses, multi-unit, costing), Accounting (fiscal periods, statements, vouchers, cost centers)
- Sales & Purchasing (quotation→invoice linking, POS, LC expenses), Production/Manufacturing
- AI features (analytics, production assistant, security, reporting, SEO, tax entry) with rule-based fallbacks
- Online Store module

## Architecture decisions

- **Modular monorepo + multi-tenancy**: pnpm workspaces; every tenant row carries `company_id` for isolation + granular RBAC.
- **Realtime sync**: SSE pushes critical SuperAdmin changes (subscription, company state) to logged-in users.
- **Production WIP cycle (SAP-style)**: `in_production` posts DR WIP / CR Raw (header labor+overhead); `completed` posts DR Finished Goods (+DR Variance/Waste) / CR WIP. FG unit cost = `wipBalance × producedQty / (producedQty + wasteQty)`. Cancel auto-reverses the issue. Header `costCenter` → every JE line. WIP setup fields lock once issue posts.
- **JE explicit-save reservation**: the journal-entry form reserves NO number on mount (no row, no sequence gap on abandon). The badge peeks the next number via `useNextSequenceNumber`. "حفظ" atomically consumes the number in `POST /api/journal-entries/`; that endpoint persists unbalanced/under-populated entries as `draft` (balanced + ≥2 valid lines → `posted`, honoring per-company auto-post via `resolvePostingStatus`). No `/reserve` endpoint. Drafts have ZERO report impact until posted.
- **Manufacturing master data**: `bom_templates`/`bom_template_lines` auto-copy raw lines (scaled `plannedQty/outputQty`) on production-order create; `manufacturing_settings` supplies per-company default warehouses/cost-center/GL accounts. Manage via `/production/bom-templates`, `/production/settings`.
- **Sister companies (الشركات الشقيقة)**: dedicated tables (`sister_companies`/`sister_transfers`/`sister_returns`/`sister_settlements`), NOT customers (shared VAT/CR → ZATCA would reject). Module `sister_companies` locked by default (SuperAdmin enables per company). Transfer JE: DR COGS+SisterAR / CR Inventory+Revenue (+ stock out); returns reverse exactly; settlement bidirectional. No VAT/UBL/QR (internal, SAR only). Routes `/api/sister-companies/*`, UI `/inventory/sister-*`.
- **Header warehouse picker**: all 8 document forms expose a header "المستودع" combobox that auto-selects the company default on new docs and broadcasts changes to every line (`applyHeaderWarehouse`); empty lines back-fill from it. Lines already carried `warehouseId` (no schema change).
- **Quotation → invoice on SAVE**: the "تحويل إلى فاتورة" button navigates to `/sales/invoices/new?fromQuotation=<id>` (seeds the form via `loadFromQuotation`, sets `sourceQuotationId`). The quotation flips to `converted` + back-links `convertedInvoiceId` ONLY when the invoice is saved (atomic race-safe UPDATE in `POST /sales-invoices`). Abandoning the form leaves it `accepted`. Legacy `POST /sales-quotations/:id/convert` still exists but is no longer called by the UI.
- **Multi-domain (إدارة النطاقات)**: SuperAdmin maps a company to its own domain (`company_domains`, one domain→one company, status pending/active/disabled, isPrimary). `resolveDomainCompany` sets `req.domainCompanyId` only for an *active* host (best-effort, never throws). In `resolveCompanyId` it is the LOWEST-priority fallback for **superadmin only**: `?companyId=` → acting-company → domain → multi-company view; tenant users always scoped to own company. Main/unmapped host keeps multi-company behavior. SA-only screen → no company module gate. Routes `/api/admin/domains/*` (+ `/:id/check` for DNS/SSL/reachability).

### POS Desktop (offline Tauri Windows app)

`artifacts/pos-desktop/` — Tauri+React+SQLite for `zacoderp.com`, feature-flagged via `companies.enable_offline_pos`. Rust compiles in CI only (no local cargo). Extensive notes in `.agents/memory/pos-desktop-*`.

- **Two-mode boot** (FirstRunWizard): **cloud** = device-license activation (Ed25519 JWT, hardware-bound) → cashier login → SalesScreen + `/api/sync/*` & `/api/device-licenses/*`; **standalone** = signed `.zacolic.json` + local bcrypt users, zero cloud calls.
- **Per-machine vertical** (general/grocery/pharmacy) gates pharma UI, EDA import, 14% VAT default. Scale serial readout + embedded-weight EAN-13.
- **ZATCA bridge**: back-office sales invoices reuse the register's `offline_invoices`→sync pipeline; build QR/payload from the PERSISTED invoice (not the form); idempotency key `sinv-<id>`.
- **ActionBar + auto-post**: list screens use a single top ActionBar bound to the *filtered* dataset (not raw rows). Source docs auto-post on save; unposting a source doc reverses GL+stock AND deletes its JE (null `je_id` first). Manual JEs keep the status-flip lifecycle.
- **Release**: push a `pos-desktop-v*` tag → GitHub Actions builds a draft Release/MSI. Main agent cannot push (sandbox-blocked + stale creds) — the USER pushes via Git pane + publishes the Release.

## User preferences

I prefer detailed explanations and a clear, concise communication style. I value iterative development and would like to be asked before any major architectural changes or significant code refactoring are implemented. Do not make changes to the `pnpm-workspace` skill.

**After EVERY change to the POS Desktop Windows app (`artifacts/pos-desktop/`), always end by stating the new version number and the release commands** (i.e. push the `pos-desktop-v<version>` tag from the Git pane, then publish the GitHub Release to build the MSI). Do this automatically without being asked.

**Always confirm the route → component mapping in `App.tsx` BEFORE editing any page.** A path like `/sales/invoices` does NOT necessarily map to `SalesInvoices.tsx`. For example `/sales/invoices` is wired to `SalesAuditGrid.tsx`, not `SalesInvoices.tsx`. Run `rg -n 'path="/the/path"' artifacts/zatca-invoicing/src/App.tsx` first, identify the actual component imported there, and edit THAT file. Do not assume by filename.

## Gotchas

- **Branch-level data isolation**: for `view_all_branches=false` users, data is scoped to assigned branches via `branchScopeSpread(req, table.branchId, req.query.branchId)` across branch-linked LIST endpoints (journal-entries, account-notes, pos-sessions, fixed-assets, warehouses, cash-boxes, bank-accounts, branches). NULL-`branch_id` rows are company-wide/shared (opening/system JEs) and stay visible from any branch (`branch_id = X OR branch_id IS NULL`); read-only for restricted users. `cash_transfers` has NO `branch_id` → intentionally not scoped. Scoping a table without a `branch_id` column 500s restricted users only.
- **Posted-only financial reports**: trial-balance, balance-sheet, income-statement, account-statement include only `status='posted'` JEs. Drafts have ZERO impact (opening/period/closing/running). Unposting (`POST /journal-entries/:id/unpost`) removes impact on next refresh. System JEs insert as `posted` directly.
- **Period closing (IFRS)**: 5 steps validate→close-pl→transfer-profit→soft-close→hard-close. Soft-close needs `force=true` if revenue/expense still non-zero (monthly). Hard-close has NO force; needs both closing-revenue/expense AND transfer-profit/loss JEs (unless zero P&L). Recover via `POST /fiscal/periods/:id/force-reopen` (SuperAdmin, reason ≥10 chars).
- **SuperAdmin acting-company impersonation**: `/admin/enter-company` writes `localStorage.zatca_acting_company_id` → auto-sent as `x-acting-company-id`. `resolveCompanyId` honors it only for `role==="superadmin"` (explicit `?companyId=` still wins). Amber banner in `Layout.tsx` is the only safe exit (clears key + invalidates ALL React Query caches). Always check `actingCompanyId` before assuming SA is in their own context.
- **Posted invoice lock**: sales/purchase invoice edit screens are read-only (`<fieldset disabled>`) when `status==="posted"`; require unposting via API.
- **Editable manager username**: `username` editable from `/users`; `PATCH /api/users/:id` trims, rejects empty (400), enforces per-company uniqueness excluding self (409).
- **Customer payment terms (مدة الاستحقاق)**: `customers.payment_terms_days`. When `>0`, `POST /api/invoices` refuses a new CREDIT invoice if any prior posted credit invoice is unpaid beyond the term (FIFO-applies receipts + credit returns oldest-first) → `409 OVERDUE_PAYMENT`. Cash invoices, NULL/0 terms, POS walk-in bypass.
- **LC expense currency default**: non-base-currency LC expenses default to base (SAR, rate=1); server enforces `exchangeRate=1` for base-currency entries.
- **Mandatory warehouse branch**: saving a warehouse (create+edit) REQUIRES a branch (frontend validates, backend `assertWarehouseBranchWritable` rejects null/empty with 400). Pre-existing NULL-branch warehouses stay readable but must be assigned on next edit.
- **Express 5 / path-to-regexp 8**: inline regex like `/:id(\d+)` is unsupported — register literal sub-segments BEFORE `/:id` (e.g. `/orders/pending-approval` before `/orders/:id` in `production.ts`; sister-companies `/transfers`,`/returns`,`/settlements` before `/:id`). Guard `Number.isInteger(id) && id>0` → 400.
- **Production order post-issue lock**: once `in_production`, WIP setup fields (raw warehouse, WIP/raw/labor/overhead accounts + amounts) are read-only (changing them corrupts WIP balance). FG-side fields stay editable until completion. Cancel to redo.

## Pointers

- **Skills**: `pnpm-workspace`, `react-query`, `drizzle-orm`, `express`, `zod`, `tailwind`, `typescript`, `ai-integration`
- **Memory**: `.agents/memory/MEMORY.md` (index) — durable lessons, ZATCA chain/CSID specifics, POS-desktop internals.
- **External docs**: [ZATCA](https://zatca.gov.sa) · [Drizzle](https://orm.drizzle.team/docs/overview) · [Zod](https://zod.dev/) · [React Query](https://tanstack.com/query/latest) · [OpenAI](https://platform.openai.com/docs/overview)
