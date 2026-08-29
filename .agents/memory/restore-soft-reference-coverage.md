---
name: Restore soft-reference coverage
description: How to keep strict full-company backup reference validation compatible with real historical backups.
---

When strengthening full-company restore validation, inventory and test the complete set of non-FK identifier columns before release. Include discriminator-based references, historical audit references, and journal aliases such as `journal_id`, not only conventionally named foreign keys.

**Why:** Strict unknown-ID rejection was correct for tenant safety, but incomplete coverage blocked a valid production backup repeatedly, revealing one unsupported column at a time after each prior blocker was fixed.

**How to apply:** Keep unknown identifiers fail-closed. Add explicit discriminator-aware mappings for operational references, nullable handling for missing historical rows, and regression fixtures that exercise every known soft-reference family together before publishing backup changes.