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