---
name: Embedded invoice payment form
description: Multi-method inline payment registration inside sales/purchase invoice Payments tabs (web ZATCA app)
---

Shared `EmbeddedPaymentForm` (components/documents) renders inline in both invoice Payments tabs (styled like the embedded account-notes card) instead of navigating to the voucher screen.

Rules learned:
- **One voucher per payment-method line** — keeps the existing per-payment-type sequence series intact; only backend paymentType values are cash|bank, so cheque/transfer/card/wallet map to bank (method label goes in description, ref in refNumber). Never invent a new numbering path.
- **Retry-safe batch**: each line carries a `done {id, code, posted}` marker persisted into state as it executes; re-submit after a partial failure skips created vouchers (only completes posting). Without this, retrying re-creates duplicate vouchers up to the remaining balance (server overcollection guard won't catch it).
- **Currency identity**: invoices carry `currencyCode`, vouchers persist `currencyId` — the form fetches /api/currencies and resolves code→id; passing only exchangeRate silently drops the voucher's currency.
- Amounts are entered in DOC currency with the invoice's exchangeRate; cap distributed ≤ summary.available (+0.005 tolerance); server re-checks in base currency under a per-invoice advisory lock.
- "حفظ وترحيل" = create then POST /:id/post per voucher (JE built in the voucher post path — unified JE series untouched).
