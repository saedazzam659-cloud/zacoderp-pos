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

**Why:** The user explicitly wants table orders preserved, delivery distinct from in-store pickup, and takeaway available as its own order flow. Reservation and waitlist records must not bypass the normal order-to-invoice lifecycle, sent kitchen tickets must not be silently reassigned during a merge or split, active kitchen routing must remain visible, kitchen staff need to identify the destination table, and resending must not reset the original timer or duplicate already-sent lines.

**How to apply:** Keep dine-in, takeaway, and delivery entry points distinct; retain table IDs for dine-in; and include channel context in billing/report details without changing existing table records. Reservations may optionally reference a table, but never alter table status or create a POS order merely because a guest is seated. Transfer by changing the existing order's table link; do not duplicate its kitchen or invoice records. Add-ons reuse item IDs so normal invoice, stock, cost, and return paths remain authoritative. Public QR requests must map through the token to one table/company, use server-side prices, and create only normal restaurant orders.
