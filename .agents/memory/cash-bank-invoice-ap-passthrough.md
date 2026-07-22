---
name: Cash/bank purchase invoice AP pass-through
description: Cash/bank-paid invoices must route through supplier AP in the JE and appear as paired lines in statements; balances endpoints must not double-count.
---

Cash/bank-paid purchase invoices originally credited bank/cash DIRECTLY, so the payment never touched supplier AP → invisible in supplier statement, supplier balance stayed دائن, and the invoice-form bank widget (voucher-math based) showed a reversed/negative bank balance.

**The pattern (keep all four in lockstep):**
1. **JE pass-through**: cash/bank non-LC invoice JE posts CR supplier AP + DR supplier AP ("سداد نقدي/بنكي للمورد") + CR bank/cash (+CR discount). Falls back to old direct credit if the supplier has no ledger account (statement pairing still shows; GL AP untouched — accepted).
2. **Bank widget GL-based**: `/bank-accounts/balances` = sum(debit−credit) over POSTED JE lines on `bank_accounts.account_id`; legacy voucher math ONLY for banks with null accountId. Never sign-flip vouchers.
3. **`/suppliers/balances`**: invoice accrual excludes `paymentType IN ('cash','bank')` (they net zero); jeRows already excludes entryType `purchase_invoice` → no double-count with the new AP legs.
4. **`/supplier-statement`**: cash/bank invoices expand to TWO paired lines — `invoice` (credit) + `invoice_payment` (debit, channel cashbox/bank). Opening (`sumPriorTo`) stays credit-only (pairs net zero). UI TYPE_LABEL/DOC_TYPE_LABEL need an `invoice_payment` entry or raw type leaks.

**Why:** statements/balances mix invoice-table aggregates with JE aggregates; any new JE leg on AP must be excluded on exactly one side or totals double.

**Returns mirror the same pattern:** cash/bank purchase returns (incl. from-invoice returns — same post endpoint) post DR AP + CR AP ("استرداد نقدي/بنكي من المورد") + DR bank/cash; `/suppliers/balances` return aggregation excludes cash/bank; statement expands them to `return` (debit) + `return_refund` (credit, channel). UI labels: `return_refund` = "استرداد مرتجع".

**How to apply:** already-posted cash/bank invoices AND returns need فك ترحيل → إعادة ترحيل to regenerate the JE with pass-through legs. `/supplier-statement-detailed` intentionally still credit-only. Same latent pattern may apply to cash/bank SALES invoices vs customer AR.
