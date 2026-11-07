---
name: Restaurant service channels
description: Preserve dine-in tables while adding distinct restaurant service channels such as delivery.
---

Delivery and takeaway are distinct restaurant channels, never replacements for dine-in tables. Keep all three order-entry paths available and make channel identity visible in cashier order lists and invoice or shift reports.

Restaurant modifiers must link to existing company inventory/service items. Snapshot the selected item and price in the order, then invoice each linked item through the normal tax, accounting, stock, and return lifecycle; never create duplicate catalog items or a parallel recipe ledger.

For customer self-ordering, the user chose QR codes at dine-in tables and cash on collection. Keep it opt-in per table, use an opaque revocable token, and leave guest orders pending staff confirmation before kitchen dispatch.

Reservations and waitlist entries are planning records, not restaurant orders. They must not create kitchen tickets, inventory movements, sales invoices, or customer charges until staff starts the existing order flow.

Moving an active dine-in order keeps the same order record so kitchen tickets and billing stay linked. Merge and split are restricted to unsent draft orders; split moves whole lines only and must leave at least one line on the source order.

Kitchen station keys remain stable when staff rename labels. Do not deactivate a station while active menu items or queued kitchen lines still use it.

Kitchen tickets for dine-in orders should show the table name or code; takeaway and delivery tickets retain their channel label without a table.

Kitchen send actions should only send pending lines without a sent timestamp. Preserve the order's first-send time, and use line send times for active ticket age so later rounds do not inherit a stale timer.

External delivery-platform orders require explicit SKU-to-existing-menu mappings. Create normal POS delivery or takeaway orders only when every line, price, tax, and total reconciles with the ERP; unsupported modifiers, discounts, and fees stay in manual review. Platform acceptance must not create a duplicate catalog item or bypass the regular cashier invoice lifecycle.

Send provider readiness or dispatch updates only after the linked POS order reaches kitchen-ready status, and choose the provider state required by its transport type. Never auto-cancel or reverse a posted invoice from a provider cancellation event; use the existing fiscal correction path.

Canceling an order should atomically cancel pending, preparing, and ready lines, preserve already-served line history, reject billed orders, and free a table only when it still points to that order. Kitchen status updates must serialize on the parent order so they cannot revive canceled lines.

Restaurant billing must also serialize with cancellation. The user chose to block cancellation while an active invoice-creation replay exists for the order; invoice creation must lock and validate the order, and a posted invoice must be linked before the order can be cancelled. Never automatically reverse a posted invoice to make cancellation succeed.

Before calling a restaurant integration untested or assigning a coverage percentage, check the existing test suite and prior validation evidence. Do not rerun an unchanged integration just to refresh a status estimate; repeat it only when relevant code changed or the user asks.

**Why:** The user clarified that restaurant integration paths had already been tested and objected when earlier coverage was treated as unknown and some checks were repeated. The user also explicitly wants table orders preserved, delivery distinct from in-store pickup, and takeaway available as its own order flow. Reservation and waitlist records must not bypass the normal order-to-invoice lifecycle, sent kitchen tickets must not be silently reassigned during a merge or split, active kitchen routing must remain visible, kitchen staff need to identify the destination table, resending must not reset the original timer or duplicate already-sent lines, and cancellation must not leave active prep lines behind. The user also selected blocking cancellation until an invoice is linked because a posted invoice otherwise could remain orphaned when cancellation wins the gap between invoice posting and order linkage.

**How to apply:** Keep dine-in, takeaway, and delivery entry points distinct; retain table IDs for dine-in; and include channel context in billing/report details without changing existing table records. Reservations may optionally reference a table, but never alter table status or create a POS order merely because a guest is seated. Transfer by changing the existing order's table link; do not duplicate its kitchen or invoice records. Add-ons reuse item IDs so normal invoice, stock, cost, and return paths remain authoritative. Public QR requests must map through the token to one table/company, use server-side prices, and create only normal restaurant orders. Keep invoice request IDs deterministic per restaurant order so create, cancel, and bill checks refer to the same replay; resolve a draft or posted invoice through its existing invoice lifecycle before allowing order cancellation.

For marketplace connectors, apply explicit product mapping and exact monetary reconciliation before POS order creation. Keep external order status synchronization separate from fiscal invoicing, and require a human-confirmed handoff before dispatching vendor-delivery orders.
