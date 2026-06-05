---
name: POS Desktop offline sales/purchases reports
description: Convention for the pos-desktop analytics report screens (Phase 2 waves)
---

# POS Desktop offline reports — Rust-thin / TS-aggregate convention

Each report screen pairs a thin Rust query command with client-side aggregation.

**Rule:** Rust report commands return *filtered raw rows only* (date range +
optional branch/customer); ALL grouping (by period / item / customer), share %,
returns-merge, and net calculations happen in the React page in TypeScript.

**Why:** Rust compiles ONLY in CI (no local cargo — see
`pos-desktop-no-local-cargo`). Keeping SQL trivial and pushing the changeable
aggregation logic into TS means new report variants rarely touch Rust and stay
typecheckable + architect-reviewable locally.

**How to apply (per new report wave):**
- Reuse the existing raw-row commands when possible before adding a new Rust fn.
  Wave 1 added 3 reusable ones: `report_sales_invoices`,
  `report_sales_invoice_lines`, `report_sales_returns`.
- New Rust report fn must: mirror `report_ledger_lines` dynamic-arg pattern
  (`Vec<Box<dyn rusqlite::types::ToSql>>` + `params_from_iter`), `db::open()`,
  struct with `#[serde(rename_all = "camelCase")]`, SELECT column order aligned
  to `r.get(idx)`, and be registered in `main.rs` invoke_handler.
- local sales/returns tables have NO status column — every saved row counts
  (do not filter by status like the financial reports do).
- Lines are stored already-net (discount baked into unit price).
- A new screen needs the full PosShell wiring set (see
  `pos-desktop-screen-wiring`): WindowsView union + VIEW_MODULE
  (module:"sales_docs", profile:"erp" for sales reports) in moduleRegistry.ts,
  ScreenKey union + SCREEN_KEYS (group "تقارير المبيعات") in permissions.ts,
  NAV_GROUPS members + nav items + render branch + labelFor in PosShell.tsx.
- Reports that only re-slice invoices/lines/returns (by customer, payment
  method, item, period; returns summaries; top-N rankings; invoice+line
  drilldowns) need NO new Rust — reuse the 3 raw-row commands and they stay
  fully local-typecheckable + architect-reviewable. Prefer this for a whole wave.
- Still need NEW Rust (deferred): customer/supplier balance/aging/statement
  (AR/AP = credit invoices − receipts, FIFO + a receipts/settlements raw reader),
  profitability (per-line FIFO cost), and free-quantity returns (a
  report_sales_return_lines reader — header-only reportSalesReturns can't show
  free qty).
