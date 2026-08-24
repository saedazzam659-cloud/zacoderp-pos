---
name: Item card balance source
description: Why item-card before/after balances must come from the posted stock ledger per warehouse.
---

Item-card rows must treat the stock ledger's persisted balance as the post-movement balance for that warehouse; the pre-movement balance is that value minus the row quantity. Never start a date-filtered result at zero and rebuild one cross-warehouse running total.

**Why:** A filtered period omits earlier movements, and an all-warehouse report interleaves independent warehouse balances. Recomputing from zero makes both opening and row balances wrong even though posting already stored the correct per-warehouse result.

**How to apply:** For inventory movement reports, show before/after from the persisted row balance. Summaries across warehouses should sum each warehouse's first pre-movement balance and last post-movement balance in the visible period.