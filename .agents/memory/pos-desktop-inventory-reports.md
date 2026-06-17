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
