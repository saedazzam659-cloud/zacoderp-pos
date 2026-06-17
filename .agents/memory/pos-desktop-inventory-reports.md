---
name: POS Desktop inventory report screens (Kardex + valuation)
description: Conventions and correctness traps for the pos-desktop offline inventory report wave
---

# POS Desktop inventory reports — Kardex (كارت الصنف) + Stock Valuation (تقييم المخزون)

Part of bringing the offline Windows POS inventory module toward web parity. Phase 1 = Kardex + valuation (most-impactful). Later phases: slow-moving, free-quantities, WAC costing, goods deliveries, bundles/smart-alerts/dashboard.

**Both screens need NO new Rust** — reuse `stock_movements_list` (Kardex) and `stock_on_hand_list` (valuation). Keeps them fully local-typecheckable per the Rust-thin/TS-aggregate convention.

**Kardex running balance is computed in TS, NOT from `balance_after`.**
The ledger's `balance_after` is per (item, warehouse); summing it across warehouses is meaningless. So the Kardex fetches the item's FULL history (no date filter), sorts ascending, and accumulates `qty_delta` itself — works for both single-warehouse and all-warehouses. Opening balance = running total of the last row strictly before `dateFrom`.

**Closing-value cost basis must be as-of `dateTo`**, never the global latest movement cost. Filter `entry_date <= dateTo` then take the last non-zero `unit_cost`; otherwise a post-period price change distorts a historical period's valuation.

**`stock_movements_list` caps at 5000 rows (`limit.min(5000)`, ORDER BY id DESC).**
**Why:** for an item with >5000 movements the OLDEST rows are dropped, so the TS-computed opening/running/closing silently understate by the dropped deltas — a real correctness bug for very active items.
**How to apply:** Kardex surfaces an explicit truncation warning when `rows.length >= 5000` rather than showing a silently-wrong balance. A true fix needs a NEW Rust command returning (opening-balance-as-of-date + in-range movements) so the full history never has to be shipped to TS.

# Phase 2 — Slow-Moving Items (الأصناف بطيئة الحركة)

`SlowMovingItems.tsx` reuses ONLY existing commands: `stock_on_hand_list` (qty+value per item, aggregated across warehouses in TS), `stock_movements_list` (last-move date per item), `list_items` (+ `itemGroupName`). No new Rust. Service-nature items excluded.

**5000-cap correctness for "no movement in sample":** do NOT force idle=9999. Derive `coverageDays` from the OLDEST sampled `entry_date` (only when truncated; Infinity = full ledger). An unsampled item is:
- genuinely never-moved (definitely slow) when the ledger was NOT truncated, OR
- definitely slow when `coverageDays >= threshold` (idle proven ≥ coverage), OR
- UNDETERMINED when `coverageDays < threshold` → excluded from the list, counted in a banner note.
**Why:** under a short 5000-row window an item moved recently-but-just-outside the window would be falsely flagged as maximally slow.

# Phase 3 — Free Quantities + Item Sales Valuation (IMPLEMENTED)

Both now exist (`FreeQuantitiesReport.tsx`, `ItemSalesValuationReport.tsx`). They required the FIRST new Rust in this report wave:

- `SalesLineReportRow` (built by ONE closure — `report_sales_invoice_lines`) gained `unit_cost` + `free_qty`. Sold free qty comes from `sales_invoice_lines_local.free_qty` (already existed); cost basis = `qty × unit_cost`.
- NEW `report_sales_return_lines` command + `SalesReturnLineReportRow` — `report_sales_returns` is HEADER-ONLY so per-item returned qty/value/free needs the line-level reader.
- `sales_return_lines_local` got an additive `free_qty REAL NOT NULL DEFAULT 0` migration. **No return-form UI sets it yet**, so `returnedFreeQty` is always 0 until that input is built — the column + netting are wired ahead of the data.
- Valuation bases: `cost=qty*unit_cost`, `excl_vat=line_total`, `incl_vat=line_total*(1+vat/100)`; every column nets sold − returned.
- Filters intentionally from/to + branch + TS item-search (matches sibling `SalesByItemReport`); web's warehouse/customer filters dropped — return lines carry no warehouse_id and the line readers don't take a customer param.
