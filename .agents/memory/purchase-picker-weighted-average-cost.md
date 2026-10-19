---
name: Purchase picker weighted-average cost
description: Keep suggested purchase cost aligned with the live inventory valuation basis rather than stale per-unit snapshots.
---

For purchase invoice defaults in the company's base currency, use the item's current weighted-average cost as the source of truth. Convert it to a selected alternate unit using that unit's base-unit conversion factor. A stored unit cost can be used only when the item has no current catalog cost. Keep currency-specific prices as their own explicit override.

**Why:** The item master is refreshed from posted stock balances after receipts, while per-unit cost snapshots can remain unchanged. Preferring those snapshots makes later purchase forms show an obsolete cost and conflicts with the system's weighted-average valuation.

**How to apply:** When changing purchase-item defaulting or unit selection, source the current item average first, convert by the selected unit's factor, and refresh cached item data after purchase posting. Do not treat a draft invoice as an inventory receipt before it is posted.
