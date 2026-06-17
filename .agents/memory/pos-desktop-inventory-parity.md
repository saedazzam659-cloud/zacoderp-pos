---
name: POS Desktop inventory parity port
description: Design decisions for the offline port of 6 web inventory features (offers, goods deliveries, units, warehouse groups, dashboard, alerts)
---

Six web inventory features were ported into the offline pos-desktop app for parity. Two carry non-obvious design decisions a future agent must not assume away:

## Offers are management-only — NO sale-time matching engine
`offers_local` (+ `offer_customers_local` / `offer_sales_reps_local` / `offer_items_local` scope tables) store offers with full scope metadata (customer/sales-rep/item `*_scope` = `all`|`specific`), but the register's SalesScreen does **NOT** auto-apply them to carts. CRUD + activate/expire only.
**Why:** the web app's sale-time engine was out of scope for the parity port; building it offline is a separate effort.
**How to apply:** if asked "why don't offers discount the cart", the answer is "no matching engine yet", not a bug. Adding one means wiring offer-match logic into the cart-add path.

## GoodsDeliveries post to a delivery-clearing account, not revenue
`goods_delivery_post` does stock-OUT at moving cost + JE **DR delivery-clearing(11092) / CR Inventory(1300)**. No revenue/VAT is booked on the delivery — that lands only when the delivery is later invoiced. `delete` on a posted delivery reverses the JE and pushes stock back IN at the stored per-line `unit_cost`.
**Why:** a goods delivery (إذن صرف) is a fulfillment document, not a sale; booking revenue here would double-count it at invoice time. 11092 is auto-created under parent 1000 if missing.
**How to apply:** convert-to-invoice is deferred (handled manually). If you add it, the invoice must clear 11092, not re-credit inventory.

## Scope read/write pattern (offers)
`write_offer_scopes` is a clear-then-reinsert inside the create/update transaction, gated per scope: rows are only inserted when the matching `*_scope == "specific"`. `offer_get` rehydrates `customer_ids` / `sales_rep_ids` / `items` via separate sub-queries (the main `row_to_offer` leaves them empty `Vec::new()`).
