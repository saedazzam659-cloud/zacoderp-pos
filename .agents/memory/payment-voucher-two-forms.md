---
name: Payment voucher two-form split
description: Why there are two payment-voucher forms and how edit/duplicate auto-dispatch decides between them.
---

The web ERP payment voucher ("سند الصرف") is served by TWO React forms sharing one
backend + one list:

- **Simple** (`PaymentVoucherFormSimple.tsx`) — legacy single-account/single-amount
  form. Routes `/cash/payment-vouchers/new` and `/cash/payment-vouchers/:id`. This is
  the default "سند الصرف".
- **Multi** (`PaymentVoucherFormMulti.tsx`) — multi-line allocation grid. Routes
  `/cash/payment-vouchers/multi/new` and `/cash/payment-vouchers/multi/:id`, title
  suffixed "(عمليات متعددة)".

**Dispatch rule (the non-obvious part):** open a saved voucher in the MULTI form iff
it has ANY allocation line (`existing.lines.length > 0`), else the simple form. NOT
">1 line".

**Why:** the backend NULLs the header `accountId` for any voucher saved with `lines[]`
(accounts live only in the lines), and multi vouchers always have ≥1 line while legacy
vouchers have none. A 1-line multi voucher opened in the simple form would therefore
show a BLANK account (apparent data loss). "Has any line" exactly reconstructs which
form authored the voucher.

**How to apply:** the Simple form performs the redirect itself after loading the
voucher — edit → `/multi/:id`, duplicate (`?from=`) → `/multi/new?from=`, both with
`{replace:true}`. Its hydrate effect early-returns when lines exist to avoid flashing.
App.tsx must keep the `/multi/*` routes registered BEFORE `/:id` (wouter Switch is
first-match) or the redirect bounces. Both sidebar entries reuse permKey
`payment_vouchers` (no new module gate). Backend accounting is identical for both
payloads — never fork the JE logic per form.
