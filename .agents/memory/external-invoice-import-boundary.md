---
name: External invoice import boundary
description: Product rules for extracting supplier/customer invoice files into the existing ERP import review flow.
---

Convert external invoice files into the existing unified invoice-row contract and show those rows for review before the user continues through the established import flow. OCR/AI extraction alone must never create, approve, or post an invoice.

Do not invent unreadable or absent dates, amounts, taxes, codes, or payment details. Match existing items and parties by code first, then by an exact unique name. Never create a party or item automatically. Keep sales invoices, purchase invoices, and both return types on the existing document pathways.

Review should allow quick value swaps between normalized columns and explicit batch- or row-level branch/warehouse choices. Unit-of-measure overrides must resolve to an existing company unit and pass through the established item-unit conversion validation.

**Why:** The user explicitly prioritizes reading files once and converting them into the system's current columns so staff do not enter the same invoice twice; accounting correctness and human review remain required.

**How to apply:** For new file formats or extraction improvements, preserve the unified row shape and the current import/review flow; leave uncertain values flagged for the reviewer, and never bypass unit conversion when a row selects a different unit.
