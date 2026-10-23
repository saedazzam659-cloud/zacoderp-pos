---
name: Historical migration uses existing masters
description: Scope rule for the current company's historical transaction migration.
---

For this migration, customers, suppliers, items, and the chart of accounts have already been loaded into the target ERP. The import should match documents to these existing records and must not duplicate or recreate the master data.

**Why:** The user confirmed these records are already in the target system and the migration focus is historical source documents.

**How to apply:** Resolve relationships using stable company-local codes/identifiers. Flag missing or ambiguous matches for correction; never silently create duplicate masters or guess a financial relationship.
