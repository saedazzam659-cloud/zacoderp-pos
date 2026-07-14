---
name: Item-group category routing (فئات الأصناف)
description: item_groups categoryType drives purchase posting + no-stock UI; mirrors service-item pattern; inventoryApi URL prefix trap.
---

- `item_groups.categoryType` (inventory|fixed_asset|expense) + auto-minted child account (supplier-style peek/mint via entityAccounts). Purchase posting: asset/expense lines = NO stock move, debit the group account; inventory-type lines with a group account debit that account but stock moves unchanged. Unpost is safe because reversal walks stock-ledger rows (no-stock lines wrote none).
- **Why:** routing mirrors the service-item pattern exactly — reuse it for any future per-item GL routing; don't invent a 4th bucket without reconciling the proportional expense split (drift) which now includes group buckets in servicePortionTotal.
- **How to apply / trap:** frontend `inventoryApi` get/post prefix EVERYTHING with `/api/inventory` — ad-hoc fetches of item-groups from other pages must use `/api/inventory/item-groups`, not `/api/item-groups` (silent 404 → no-stock gating silently off).
- Account mint is NOT in one tx with the group insert (same accepted risk as supplier pattern): failed group write can orphan a minted child account.
