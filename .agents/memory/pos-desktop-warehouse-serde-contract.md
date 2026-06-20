---
name: POS Desktop warehouse serde wire-name contract
description: Why the offline Warehouse struct mixes camelCase and snake_case on the wire.
---

The offline `Warehouse` / `WarehouseInput` Rust structs (inventory.rs) carry
`#[serde(rename_all = "camelCase")]` BUT pin `is_default` and `is_active` back to
snake_case via explicit `#[serde(rename = "is_default")]` / `#[serde(rename = "is_active")]`.

**Why:** the original Warehouse struct had NO rename, so the whole app was built
reading `w.is_default` / `w.is_active` (snake) — these two booleans are consumed
across ~13 screens (PurchasesAdmin, PurchaseOrdersAdmin, GoodsReceipts/Deliveries,
Sales*, Stock*, etc.) to find the default/active warehouse. When the camelCase
parity fields (nameEn, groupId, branchId, allowNegative, negativeLimit, accountId)
were added, switching the whole struct to camelCase would have silently renamed
those two booleans to isDefault/isActive and broken every default-warehouse lookup
at runtime (TS reads undefined → no default found). Pinning just those two keeps
old consumers working while the new fields ride camelCase to match their TS interface.

**How to apply:** if you add another field to this struct, name it so camelCase is
correct for TS. NEVER add a third snake_case boolean expecting auto-conversion —
add an explicit `#[serde(rename)]`. The single base `name` column doubles as the
Arabic name (nameAr); there is no separate name_ar column.
