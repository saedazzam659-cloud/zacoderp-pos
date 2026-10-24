---
name: Historical migration uses existing masters
description: Scope rule for the current company's historical transaction migration.
---

For this migration, customers, suppliers, items, and the chart of accounts have already been loaded into the target ERP. The import should match documents to these existing records and must not duplicate or recreate the master data.

The user will manually create the fiscal years and annual document sequences in the ERP before importing. Use one annual sequence per document type and preserve the existing independent counter for each branch; the importer should consume these settings, not create or reset them.

Keep each document's legacy source number separate from the ERP-generated official sequence number. The source number is a historical/customer reference, not a sequence to reserve or reuse.

**Why:** The user confirmed that target master data, fiscal years, and annual sequences are managed manually. They also need the old invoice number searchable because customers hold copies bearing that number; it must remain a separate reference from the new ERP sequence.

**How to apply:** Resolve relationships using stable company-local codes/identifiers. Flag missing or ambiguous matches for correction; never silently create duplicate masters or guess a financial relationship. Require fiscal periods and sequences to be configured before import; do not create or reset them automatically.
