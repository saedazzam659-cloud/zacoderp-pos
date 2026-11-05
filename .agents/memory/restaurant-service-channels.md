---
name: Restaurant service channels
description: Preserve dine-in tables while adding distinct restaurant service channels such as delivery.
---

Delivery is an additional restaurant channel, never a replacement for internal dine-in tables. Keep existing table setup and ordering available, and make the channel visible in cashier order lists and invoice or shift reports.

Restaurant modifiers must link to existing company inventory/service items. Snapshot the selected item and price in the order, then invoice each linked item through the normal tax, accounting, stock, and return lifecycle; never create duplicate catalog items or a parallel recipe ledger.

**Why:** The user explicitly wants table orders preserved and delivery clearly identifiable as an additional service.

**How to apply:** Keep dine-in and delivery entry points distinct, retain table IDs and links for dine-in, and include channel context in billing/report details without changing existing table records. Add-ons reuse item IDs so normal invoice, stock, cost, and return paths remain authoritative.
