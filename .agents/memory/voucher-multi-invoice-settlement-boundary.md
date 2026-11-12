---
name: Simple voucher multi-invoice settlements
description: Product and accounting constraints for allocating one simple payment or receipt voucher across open invoices.
---

Simple payment and receipt vouchers may settle multiple open invoices only for the voucher's selected supplier or customer and in the currency used by the invoice balances. Until invoice document currency is persisted independently from base-currency amounts, allow allocations only through a base-currency cashbox or bank; do not compare native-currency voucher amounts to converted invoice balances. Default shares are proportional to the remaining balances; users may edit positive percentages if they total 100%. Persist multi-invoice allocations as settlement links, not voucher lines, so one voucher still creates one cash/bank posting. Preserve the legacy header link for a single invoice.

**Why:** The user chose multi-invoice allocation to reduce repetitive voucher entry without creating extra ledger postings or changing established single-invoice behavior. POS Desktop invoice amounts are stored in base currency after foreign-price conversion, while voucher amounts are entered in the selected cashbox or bank's native currency.

**How to apply:** Keep party/currency and overpayment checks server-side and transactional, exclude the current voucher's own links when recalculating its remaining balance during edits, and revisit the base-currency restriction only after persisted invoice currency and exchange-rate data support safe conversions.
