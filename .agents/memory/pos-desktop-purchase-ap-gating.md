---
name: POS Desktop purchase AP gating asymmetry
description: When building supplier (AP) statement/aging/balance reports, which purchase docs touch the AP account — purchases gate on credit, returns never gate.
---

Supplier-ledger reports in pos-desktop (SupplierStatement / Detailed / Aging / Balances) must mirror exactly what hits the supplier `ap_account_id` in the GL:

- **Purchases**: only `payment_method === 'credit'` touch AP. Cash/bank purchases credit cash/bank, not AP — exclude them from the AP statement.
- **Purchase returns**: ALWAYS touch AP. `purchase_returns_local` has **no** `payment_method` column and `purchase_return_create` unconditionally debits the supplier AP account (`DR ap / CR inventory + CR vat-in`) and reduces `suppliers_local.balance`. So every return is an AP debit — do NOT try to gate returns by a payment method or by the original purchase's method.

**Why:** a code review assumed returns mirror the purchase credit-gating and flagged "include all returns" as a bug. It is not — the data model gives returns no payment method, so the only correct behavior is to include them all. Gating them would desync the report from the actual AP ledger.

**How to apply:** AP running balance = opening + Σ(credit − debit) where positive = we owe (دائن). Credit purchase → credit AP; return → debit AP; payment voucher (صرف) → debit; receipt/refund (قبض) → credit. Period inclusive on both ends; opening = net of everything strictly before fromDate.
