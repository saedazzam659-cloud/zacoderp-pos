---
name: Manufacturing assets as route machines
description: User-approved link from a Fixed Asset's manufacturing flag to Smart Manufacturing machine selection.
---

When a Fixed Asset is marked as used in manufacturing, Smart Manufacturing should make it available as a linked route machine without requiring a separate manual resource-link step.

**Why:** The user confirmed that manual resource linking is not available in the Smart Manufacturing route setup and chose automatic provisioning from the asset's manufacturing flag.

Only active fixed assets explicitly marked `usedInManufacturing` are eligible in a new fixed-asset-to-machine link picker. If an eligible asset already has a machine resource, select that machine rather than offering the asset for a duplicate link. Standalone and rented machines remain valid resources.

**Why:** The user wants production stages to preserve depreciation-cost attribution to the fixed asset; linking an ineligible asset can silently omit that cost, and relinking an auto-provisioned asset creates a duplicate path.

**How to apply:** Keep asset-to-machine sync idempotent, tenant- and branch-scoped, and limited to active manufacturing assets. Enforce eligibility on both the picker and server mutation. Reuse existing linked machines; never create extra depreciation or accounting postings. Preserve existing order-stage snapshots when an asset is later disabled.
