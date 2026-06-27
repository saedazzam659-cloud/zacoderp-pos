---
name: Cloud POS service-icon visibility gating
description: How the cashier top-bar service icons (kitchen/waiter/settings/analytics/supermarket) are gated per-terminal + per-cashier
---

Cloud POS (`artifacts/pos`) cashier top bar shows 5 toggleable "service" icons,
each mapping to a route: kitchen→/kitchen, waiter→/waiter, settings→/restaurant-settings,
analytics→/restaurant-ai, supermarket→/super.

Visibility is resolved server-side via `GET /api/pos-terminals/effective-services`
(must stay registered BEFORE `/:id` routes): caller's open pos_session → terminal
default (`pos_terminals.enabled_services`) → per-cashier override
(`pos_terminal_users.enabled_services`). Override beats default; **`null` at either
level = ALL visible (backwards compatible)**; admin/superadmin always get all.
Configured in ERP `محطات البيع` (PosTerminals.tsx): terminal form checkboxes +
TerminalUsersDialog per-cashier inherit/custom.

**Why the waiter key gates TWO buttons:** the cashier has two distinct restaurant
entry points that are easy to conflate:
- `/waiter` (WaiterApp) = order-taking app (open tables, add items, send to kitchen).
- `RestaurantOrdersDialog` ("طلبات الصالة") = the *cashier's billing* view (collect
  payment for ready/served orders).
Both are waiter-service functionality, so the `waiter` gate shows BOTH (nav icon +
billing dialog). Do not "fix" waiter→/waiter by replacing the billing dialog with
navigation — that drops the cashier billing flow.
