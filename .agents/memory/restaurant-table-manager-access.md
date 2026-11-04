---
name: Restaurant table manager access
description: Company managers manage restaurant tables while cashier entry stays station-bound.
---

Company managers should be able to create and maintain restaurant tables. Cashier accounts should use the assigned POS station and should not gain restaurant-settings permissions merely to complete login.

**Why:** The user expects managers to configure restaurant tables separately from cashier sales access.

**How to apply:** Keep `pos_waiter` company activation and per-user edit permissions as the access boundary. If a manager is blocked, diagnose the missing company or user grant rather than bypassing those checks globally.
