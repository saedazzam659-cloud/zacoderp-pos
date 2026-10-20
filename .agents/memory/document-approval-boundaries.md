---
name: Document approval boundaries
description: User-confirmed direction for multi-stage approvals across sales and purchasing documents.
---

Required approval stage counts are configured separately for each supported document type. A user's approval grant must also be specific to the document type; the existing user approval level and amount cap remain in force.

**Why:** The user chose per-document stage counts so invoices, orders, quotations, deliveries, and receipts can follow different approval paths without introducing a separate module.

**How to apply:** Keep approval status and its audit history separate from accounting posting, stock movement, and ZATCA submission. Default missing stage settings to the existing workflow, and never allocate a second invoice number when an approval is completed.
