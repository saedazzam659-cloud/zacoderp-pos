---
name: Historical migration uses existing masters
description: Scope rule for the current company's historical transaction migration.
---

For this migration, customers, suppliers, items, and the chart of accounts have already been loaded into the target ERP. The import should match documents to these existing records and must not duplicate or recreate the master data.

The user will manually create fiscal years and annual document sequences in the ERP before importing. Imports that will post must use one annual sequence per document type and preserve the independent counter for each branch; draft-only saves use draft numbering and must not be blocked by annual-sequence preflight.

The user reports that alkamilERP.com receives the latest Replit publish; do not dismiss screenshots from that domain as a different deployment solely because deployment metadata lists other URLs.

Keep each document's legacy source number separate from the ERP-generated official sequence number. The source number is a historical/customer reference, not a sequence to reserve or reuse.

**Why:** The user confirmed that target master data, fiscal years, and annual sequences are managed manually. Draft-only saves do not consume official numbers, so requiring an annual sequence before saving a reviewable draft blocks a safe workflow unnecessarily. The old invoice number must remain separately searchable from the new ERP sequence.

**How to apply:** Resolve relationships using stable company-local codes/identifiers. Flag missing or ambiguous matches for correction; never silently create duplicate masters or guess a financial relationship. Require fiscal periods before import and require configured sequences only when consuming official numbers; do not create or reset periods or sequences automatically.
