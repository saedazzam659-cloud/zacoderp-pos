---
name: Return numbering transaction boundary
description: Preserve gap-safe sales and purchase return creation and fail-closed sequence repairs.
---

Sales and purchase return allocation, draft header insertion, and line insertion belong in one caller-owned transaction. A failed create rolls back its reservation; a successfully committed return keeps its number even if later deleted.

**Why:** Standalone allocation could commit the counter and sequence log before the return existed, leaving a gap when header or line persistence failed. Reusing a number after a committed return deletion remains unsafe without verified deletion evidence.

**How to apply:** Pass the active transaction through the payment-series allocator only for return create flows, and keep header plus all lines in that transaction. Do not change other document types' allocation policy without reviewing their external issuance and audit guarantees.

The SuperAdmin repair tool must refuse a scoped repair if the selected sequence also feeds a different transaction type; its live-row and reservation checks do not cover every other stream sharing that counter. Same-kind payment/foreign/mobile aliases may remain together. Distinct invoice and return sequence rows are independent and should not trigger this guard.

**Why:** Resetting one stream's counter on a shared sequence can shift another stream, while correcting a number can collide with claims the scoped repair never checks.

**How to apply:** Compare the selected sequence's configured transaction types with the complete allocator candidate set for that document kind. Fail closed on unknown or cross-kind types; do not infer sharing merely from similar prefixes.

During a batch repair, a legacy null-`ref_id` reservation for an active selected draft may be released only if it is the sole exact/numeric-equivalent claim in that sequence, its transaction type is configured on the resolved sequence, and that draft is the sole live company-wide owner of the number. Keep ambiguous claims blocked.

**Why:** Return creation allocates before inserting the row, so historical sequence logs may lack a document ID. Rejecting every such claim makes legitimate draft-gap repair impossible; matching by number alone could instead release another document's reservation.

**How to apply:** Record the exact released log ID and that it was matched to the unique active draft in the repair audit. Continue requiring deletion proof for a target number claimed by a deleted row, and preserve the shared-sequence guard.