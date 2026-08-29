---
name: Cross-company restore account ownership
description: Safety rule for accounting references restored into a different company.
---

Every accounting account reference restored into another company must be remapped to an account owned by the target company. Document posting must validate all proposed journal-line accounts before inserting the journal header; stale document-level IDs may fall back to a valid target mapping or stable default account code.

**Why:** A cross-company restore can leave numerically valid or missing source-company account IDs in document headers and mappings. The schema remains healthy, but posting fails at the journal-line FK or silently books against another tenant.

**How to apply:** Validate tenant ownership for document, mapping, warehouse, item, party, cash, and bank account references after restore. Never trust a restored numeric account ID by itself; remap from the restore ID map or a reviewed stable code.