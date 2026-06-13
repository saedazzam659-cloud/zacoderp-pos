---
name: Item-master cost write-back
description: Why purchase/GRN posting must explicitly refresh items.cost_price, not just stock_balance
---

`stock_balance.avg_cost` is the per-warehouse weighted-average cost maintained by
`upsertBalance` (and the inlined WAC logic in GRN post). The الأصناف (items) grid's
تكلفة column reads a SEPARATE single field `items.cost_price`, which nothing wrote
back to after a stock inflow — so it stayed at whatever the user typed on item
creation (usually 0.00) no matter how many purchases were posted.

**Rule:** every inflow path that mutates stock cost must also call
`refreshItemCost(companyId, itemId, executor)` (in `lib/stockHelpers.ts`). It
recomputes the COMPANY-WIDE WAC = `SUM(qty*avg_cost)/SUM(qty)` across all
warehouses from `stock_balance` and writes it to `items.cost_price`. It skips the
write when total qty ≤ 0 so an out-of-stock item keeps its last known cost rather
than zeroing.

**Why company-wide, not per-warehouse:** `items.cost_price` is a single scalar
shown once per item, so it must aggregate every warehouse, not reflect just the
last-touched one.

**How to apply:** wired into `PATCH /purchase-invoices/:id/post` (after the stock
loop, per affected itemId) and `PATCH /goods-receipts/:id/post` (inside the tx,
passing `tx` as executor). GRN-sourced purchase invoices skip the invoice-level
stock loop (`continue` on `grnSourced`), so their cost refresh happens in the GRN
post path — don't double-handle them. Any NEW stock-inflow endpoint (adjustments,
transfers-in revaluation, opening balances) that should reflect on the item master
must call refreshItemCost too.
