---
name: VAT JE lines carry NO cost center
description: Auto-generated journal-entry VAT lines must be booked without a cost center; explicit null opts out of header fallback.
---

**Rule:** every auto-generated VAT line (sales invoice/return, purchase invoice/return, multi payment-voucher input VAT) is booked with `costCenter: null` — tax is not an operating cost of any cost center.

**Why:** header cost centers used to propagate onto VAT lines via the `l.costCenter ?? opts.costCenter` fallback in the sales/purchasing `createJournalEntry` helpers, tagging VAT rows to cost centers (user rejected this).

**How to apply:** in both helpers the fallback is now `l.costCenter !== undefined ? (l.costCenter || null) : header` — an EXPLICIT `null` on a line opts OUT of header inheritance; only `undefined` falls back. When adding any new auto-JE path that emits a VAT line, pass `costCenter: null` explicitly. Receipt vouchers have no tax fields; fixed-asset journals emit no VAT lines. The PV VAT line keeps supplier tax metadata (needed for كشف حساب الضريبة).
