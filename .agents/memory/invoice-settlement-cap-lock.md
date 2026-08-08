---
name: Invoice settlement overpayment cap lock
description: How the credit-invoice settlement cap (vouchers + manual JEs) is made race-safe.
---

Rule: every write path that can add settlement value against a credit invoice (receipt/payment voucher POST+PUT, journal-entry POST+PUT with an invoice link) must run inside `db.transaction`, take `acquireSettlementLock(tx, cid, kind, invoiceId)` (pg_advisory_xact_lock, key1 = cid*2 + (sales?0:1), key2 = invoiceId), then RE-run the overpayment assertion inside the tx. Assertion errors bubble via `.catch` → 400 with the Arabic message; handler must `if (!row) return;` after the catch-returns-[null] pattern.

**Why:** a plain pre-check (check-then-write) lets two concurrent saves both pass the ≤-remaining cap and jointly overpay the invoice.

**How to apply:** any NEW settlement path (new voucher type, import, API) must reuse the same lock helper + in-tx re-check in `lib/invoiceSettlement.ts` — never a standalone pre-check. Exclude the row's own old amounts on PUT (excludeId).

**Voucher header-link apply (سندات كسداد):** applying an existing unlinked voucher to an invoice sets ONLY the header link — `sumVouchersForInvoice` then counts the FULL header amount, so the apply endpoint must REJECT (409) when voucher base > remaining; no clamping is possible (unlike JE apply). The invoice advisory lock does NOT serialize two requests linking the SAME voucher to DIFFERENT invoices — the claim must be a conditional `UPDATE … WHERE link IS NULL RETURNING`. Candidates must exclude vouchers with any line-level invoice link, and apply/unlink by-id must carry multiBranchScopeSpread.
