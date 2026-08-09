---
name: Invoice list payment status
description: حالة السداد column + voucher invoice pickers must use the batch settlement formula, not the latest-voucher badge
---

The purchase/sales invoice LIST endpoints expose real `paymentStatus/paidAmount/remainingAmount/netDueAmount` via `batchInvoiceSettlementStatus` in `lib/invoiceSettlement.ts` (fixed-query batch mirror of `sumVouchersForInvoice` + `sumSettlementJEs` + returns, base currency, draft+posted both count).

**Rules learned the hard way:**
- The old `paymentSettlement` badge (latest posted voucher) misses manual-JE settlements and partial links entirely — never use it as "paid" truth; keep it only as a clickable voucher chip.
- **Payment voucher LINES settle `amount + tax_amount`** (cash paid includes VAT; the payment-voucher route guards sum both). Receipt voucher lines have NO tax column. Any settlement sum missing the tax leaves purchase invoices "partial" by the VAT.
- **Cash/bank (non-credit) POSTED invoices are auto-settled at posting** — mark paid=netDue in status computation; JE/voucher linking already rejects non-credit.
- Voucher invoice pickers (all 4 forms: simple PV/RV, multi PV line-select, multi RV) hide invoices with `remainingAmount <= 0.01`, but must keep the currently-linked invoice selectable in edit mode (unshift / form.lines / current line value).
- Auto-fill of voucher amount on invoice pick uses `remainingAmount ?? totalAmount` (base currency).

**How to apply:** any new surface showing "is this invoice paid" or offering invoices for settlement must consume these list fields (or the batch helper), never re-derive from vouchers alone.

**Voucher settlement candidates (سندات غير مرتبطة on the invoice السداد tab):**
- MULTI vouchers store `entity_id = NULL` on the header (party lives on the allocation LINE via its account). Candidate matching must OR in: entity-null vouchers with a line hitting the invoice party's account — skipped when the party account is SHARED (>1 supplier/customer). Available base for those = SUM of the party-account lines only (payment lines add tax_amount; receipt lines have none), minus invoice-linked party lines and settlement_links; apply-settlement mirrors the same base.
- Trap: a variable declared in the LIST handler referenced inside the candidates handler → ReferenceError → permanent 500 and an always-empty section (esbuild doesn't typecheck cross-handler scope; api-server isn't tsc-clean so it slipped).
