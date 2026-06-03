---
name: Document conversion handlers drop new header columns
description: Any new header-level column on sales/purchase documents must be propagated through the 5 doc→invoice conversion inserts, not just create/update.
---

# Header columns silently dropped by document-conversion handlers

When you add a new header-level column to the document tables (sales_invoices /
sales_quotations / sales_orders / purchase_invoices / purchase_orders /
goods_receipts / goods_deliveries), wiring it into the direct create (`POST`)
and update (`PUT`) handlers is **not enough**. There are five separate
"convert source → draft invoice" endpoints that build a fresh invoice payload
from the source row and will silently omit any column you don't explicitly copy:

- `sales-quotations/:id/convert` (quotation → sales invoice)
- `sales-orders/:id/convert` (order → sales invoice)
- `purchase-orders/:id/convert` (PO → purchase invoice)
- goodsReceipts `/:id/convert-to-invoice` (GRN → purchase invoice)
- goodsDeliveries `/:id/convert-to-invoice` (GDN → sales invoice)

The source row comes from a full `db.select()` so the new column IS present on
the object — just copy it: `taxId: (src as any).taxId ?? null`.

**Why:** these converted drafts are real documents the user finishes and posts;
dropping the column means a converted invoice loses metadata the original had,
producing an inconsistency that typecheck/architect-without-the-list won't catch.

**How to apply:** after adding any document header column, grep the four route
files (`sales.ts`, `purchasing.ts`, `goodsReceipts.ts`, `goodsDeliveries.ts`)
for `convert` and confirm the new column appears in every `insert(...Invoices...)
.values({...})` there, not only in the primary create/update.

## Related: header pickers must recompute derived line totals
A header picker that broadcasts a value to every line (e.g. tax rate → line
`vatRate`) must ALSO recompute each line's stored `lineTotal` via the form's
own `calcLine(...)`, because these forms submit line objects as-is. Updating
only `vatRate` leaves `lineTotal` stale and persists inconsistent line data.
Also: edit-loaders that set the header value from the loaded row must assign
null-safely (`set(row.x != null ? String(row.x) : "")`) — a bare
`if (row.x != null) set(...)` leaks the previous record's value when switching
from a populated record to an empty one while the form stays mounted.
