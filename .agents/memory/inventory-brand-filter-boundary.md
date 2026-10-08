---
name: Inventory brand filter boundary
description: Preserve the item-level semantics and inventory-only scope of brand filters.
---

Brand links are explicit many-to-many item↔brand associations and always reference a real brand. The create-item form may optionally select a brand, with the link created only after the item exists. Inventory report filters match linked items; if an item is linked to multiple brands, each selected brand includes the item's full stock and history rather than allocating or splitting its quantities. An empty brand filter must preserve existing results. Keep brand filtering out of sales and purchasing report surfaces.

**Why:** The user specified that brands classify items, not portions of stock, and limited this feature to standard inventory reports.

**How to apply:** Filter report rows by linked item membership before calculating totals or pagination. Keep new-item selection optional and validate brand ownership when creating the link.
