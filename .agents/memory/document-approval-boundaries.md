---
name: Document approval boundaries
description: User-confirmed direction for multi-stage approvals across sales and purchasing documents.
---

Required approval stage counts are configured separately for each supported document type. A user's approval grant must also be specific to the document type; the existing user approval level and amount cap remain in force.

**Why:** The user chose per-document stage counts so invoices, orders, quotations, deliveries, and receipts can follow different approval paths without introducing a separate module.

**How to apply:** Keep approval status and its audit history separate from accounting posting, stock movement, and ZATCA submission. Default missing stage settings to the existing workflow, and never allocate a second invoice number when an approval is completed.

When the configured stage count rises, a prior `approved` marker is not sufficient by itself; compare the logged approval count to the new requirement. Approval gates must also apply the same company and branch scope as the underlying document route.

**Why:** A status marker can become stale after settings change, and an unscoped preflight can reveal or gate a document outside the user's branch.

**How to apply:** Re-evaluate completion from both the latest approval status and the number of approvals, and scope every status, approval, and preflight document lookup.
