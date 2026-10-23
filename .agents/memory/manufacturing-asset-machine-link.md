---
name: Manufacturing assets as route machines
description: User-approved link from a Fixed Asset's manufacturing flag to Smart Manufacturing machine selection.
---

When a Fixed Asset is marked as used in manufacturing, Smart Manufacturing should make it available as a linked route machine without requiring a separate manual resource-link step.

**Why:** The user confirmed that manual resource linking is not available in the Smart Manufacturing route setup and chose automatic provisioning from the asset's manufacturing flag.

**How to apply:** Keep the sync idempotent, tenant- and branch-scoped, and limited to active assets. Reuse an existing linked machine; never create extra depreciation or accounting postings. Preserve existing order-stage snapshots when an asset is later disabled.
