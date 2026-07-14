---
name: Invoice settlement overpayment cap lock
description: How the credit-invoice settlement cap (vouchers + manual JEs) is made race-safe.
---

Rule: every write path that can add settlement value against a credit invoice (receipt/payment voucher POST+PUT, journal-entry POST+PUT with an invoice link) must run inside `db.transaction`, take `acquireSettlementLock(tx, cid, kind, invoiceId)` (pg_advisory_xact_lock, key1 = cid*2 + (sales?0:1), key2 = invoiceId), then RE-run the overpayment assertion inside the tx. Assertion errors bubble via `.catch` → 400 with the Arabic message; handler must `if (!row) return;` after the catch-returns-[null] pattern.

**Why:** a plain pre-check (check-then-write) lets two concurrent saves both pass the ≤-remaining cap and jointly overpay the invoice.

**How to apply:** any NEW settlement path (new voucher type, import, API) must reuse the same lock helper + in-tx re-check in `lib/invoiceSettlement.ts` — never a standalone pre-check. Exclude the row's own old amounts on PUT (excludeId).
