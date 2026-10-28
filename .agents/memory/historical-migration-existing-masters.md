---
name: Historical migration uses existing masters
description: Scope rule for the current company's historical transaction migration.
---

For this migration, customers, suppliers, items, and the chart of accounts have already been loaded into the target ERP. The import should match documents to these existing records and must not duplicate or recreate the master data.

The identified legacy source is RAGM Cloud (erp.ragmcloud.net). The user's end goal is a final company cutover: collect the complete authorized company dataset into a single intermediate export, import it into the current ERP, reconcile it, and stop relying on RAGM. The user expects the migration tool to help collect the data; a user-prepared template upload is not the intended end state.

The user reports that RAGM refused to prepare a company export. They specifically want to collect their own company's data by signing in and assembling a backup file. Do not treat vendor-provided export as available; do not request credentials in chat.

Do not accept login credentials in chat or use an unrestricted AI browser. Any collector must be source-specific, authorized, read-only, company-scoped, and explicit about unsupported data classes. Do not claim full extraction until every required dataset is verifiably covered.

The user will manually create fiscal years and annual document sequences in the ERP before importing. Imports that will post must use one annual sequence per document type and preserve the independent counter for each branch; draft-only saves use draft numbering and must not be blocked by annual-sequence preflight.

The user reports that alkamilERP.com receives the latest Replit publish; do not dismiss screenshots from that domain as a different deployment solely because deployment metadata lists other URLs.

Keep each document's legacy source number separate from the ERP-generated official sequence number. The source number is a historical/customer reference, not a sequence to reserve or reuse.

An optional fiscal-year selection on invoice batches is a review reference only. Preserve each invoice's extracted date and route it to the open fiscal period and matching sequence for that actual date; warn about invoices outside the selected reference year without blocking valid invoices in another open year. For batch duplicates, compare document kind, source number, party, and the invoice-header issue timestamp (not the PDF print-footer timestamp); require likely duplicates to be removed or corrected before saving.

**Why:** The user confirmed that target master data, fiscal years, and annual sequences are managed manually, and needs a final cutover so companies no longer need RAGM while retaining searchable history. Completeness and reconciliation are essential; partial template imports do not meet the goal. Draft-only saves do not consume official numbers, so requiring an annual sequence before saving a reviewable draft blocks a safe workflow unnecessarily. The old invoice number must remain separately searchable from the new ERP sequence.

**How to apply:** Build toward a source-specific collector that produces a reviewable intermediate package, then import through existing target lifecycles. Resolve relationships using stable company-local codes/identifiers. Flag missing or ambiguous matches for correction; never silently create duplicate masters or guess a financial relationship. Reconcile counts, balances, stock, links, attachments, and document classes before declaring cutover complete. Require fiscal periods before posting and configured sequences only when consuming official numbers; do not create or reset periods or sequences automatically. Keep optional reference-year warnings separate from blocking fiscal-period and sequence validation.
