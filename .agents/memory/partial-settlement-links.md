---
name: Partial settlement via settlement_links
description: سداد جزئي — generic settlement_links table letting JEs and vouchers settle invoices partially; invariants for sums, locks, and edit guards.
---

Table `settlement_links` (source_type 'je'|'receipt_voucher'|'payment_voucher', source_id, sales/purchase_invoice_id, amount in SOURCE currency). Legacy header FK links remain valid; links are ADDITIVE.

Rules:
- **Every** invoice-paid aggregation must include link sums: sumSettlementJEs and sumVouchersForInvoice add them; the voucher create/update overcollection guards (assertNoSalesOvercollection / assertNoPurchaseOverpayment) must ALSO add voucher-sourced link sums via sumPartialLinksForInvoice or a new voucher can overpay an already partially-settled invoice.
- Payment-voucher line allocation consumes `amount + taxAmount` (header = net + VAT). Candidates/apply consumption that sums only `amount` overstates availability.
- Apply path: acquireSettlementLock(invoice) THEN acquireSourceLock (namespace cid*4+3, negative key), compute available = source total − line allocs − prior links INSIDE the tx, clamp to invoice remaining, insert link.
- Voucher PUT must reject amount reductions below (new inv-linked lines + links consumed) — sumConsumedFromSource — else links exceed the source.
- Unlink: by linkId, or fallback body invoiceId deletes all partial links for that voucher+invoice when not header-linked. List endpoints attach `appliedForInvoice`; frontend uses it (fallback to full amount) for summaries and shows applied/total.
- Link amounts are in SOURCE currency; convert with the source's exchangeRate when aggregating in base.

**Why:** JE of 100k applied to a 5.9k invoice used to consume the whole 100k (all-or-nothing header link).
