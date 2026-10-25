---
name: External invoice import boundary
description: Product rules for extracting supplier/customer invoice files into the existing ERP import review flow.
---

Convert external invoice files into the existing unified invoice-row contract and show those rows for review before the user continues through the established import flow. OCR/AI extraction alone must never create, approve, or post an invoice.

The downloadable template is a convenience, not a prerequisite: supported external files that do not use its headers should still be read and converted. Treat provider overload as a temporary service failure, not as proof that the user's file is invalid; retry transient failures and keep the explanation and recovery action clear.

Do not invent unreadable or absent dates, amounts, taxes, codes, or payment details. Match existing items and parties by code first, then by an exact unique name. Never create a party or item automatically. Keep sales invoices, purchase invoices, and both return types on the existing document pathways.

Review should allow quick value swaps between normalized columns and explicit batch- or row-level branch/warehouse choices. Unit-of-measure overrides must resolve to an existing company unit and pass through the established item-unit conversion validation.

Historical import must offer four explicit posting modes before approval: financial plus inventory, financial only, inventory only, and archive only. Financial-only uses the ERP's normal financial entries and system item cost when available, without changing warehouse quantities; block posting if a reliable cost cannot be determined. Inventory-only updates stock quantity/cost without journal entries. Archive-only must not post either effect. Warn that single-dimension modes can make financial and stock reports diverge, and preserve the chosen mode across later edits or repost attempts.

When source invoices are marked paid or partially paid but receipt links/payment methods are absent, keep intake moving by saving editable, unposted drafts in the intended financial mode. Do not use archive-only for this staging: that mode is permanently non-postable. Do not post until settlement data is reviewed; any temporary credit value is only a draft placeholder.

**Why:** The user prioritizes importing invoice records without waiting for payment exports, while explicitly choosing to wait before financial posting. Draft staging satisfies both without changing reported balances.

**How to apply:** For new file formats or extraction improvements, preserve the unified row shape and current import/review flow; leave uncertain values flagged, never bypass unit conversion, and do not create masters automatically. Keep the template optional. Preserve the intended posting mode on staged drafts and keep financial posting blocked until settlement details are reviewed. Distinguish source-file problems from temporary extraction-provider outages.
