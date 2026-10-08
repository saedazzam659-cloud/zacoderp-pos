---
name: Simple voucher multi-invoice settlements
description: Product and accounting constraints for allocating one simple payment or receipt voucher across open invoices.
---

Simple payment and receipt vouchers may settle multiple open invoices only for the voucher's selected supplier or customer and only when all selected invoices share a currency. Default shares are proportional to the remaining balances; users may edit positive percentages if they total 100%. Persist multi-invoice allocations as settlement links, not voucher lines, so one voucher still creates one cash/bank posting. Preserve the legacy header link for a single invoice.

**Why:** The user chose multi-invoice allocation to reduce repetitive voucher entry without creating extra ledger postings or changing established single-invoice behavior.

**How to apply:** Keep party/currency and overpayment checks server-side and transactional, and exclude the current voucher's own links when recalculating its remaining balance during edits.
