---
name: Opt-in per-payment-type doc numbering
description: How split-by-payment-type document numbering coexists with the unified ZATCA chain in zatca-invoicing.
---

# Per-payment-type document numbering (opt-in)

Sales/purchase invoices and receipt/payment vouchers can OPTIONALLY draw their
human-readable doc number from a payment-type-specific series
(`<base>_<cash|credit|bank>`), falling back to the unified base series when no
split series exists.

**Rule:** the sequence sub-type MUST be resolved from the SAME normalized
payment type the document is persisted with. In convert/order→invoice paths,
compute the normalized `pType` (e.g. `ord.paymentType || "credit"`) BEFORE
issuing the number, then pass that to `nextSequenceForPayment` — never the raw
nullable `ord.paymentType`.

**Why:** a legacy/null order payment type persists the invoice as `credit` but,
if you issue the number off the raw null, the engine resolves the base series
instead of `<base>_credit` → the doc number silently lands in the wrong series.

**How to apply:** any new issuance/peek site for these doc types uses
`nextSequenceForPayment(cid, base, normalizedPaymentType, opts)` (server) /
`useNextSequenceNumber(type, enabled, date, branchId, paymentType)` (client),
and the client peek must pass the same payment type the form will submit or the
badge previews a different series than issuance persists.

**Invariant:** ZATCA ICV/PIH/hash chain is UNTOUCHED — it derives from
`MAX(zatcaIcv)+1` / previous `invoiceHash` on the invoice table, never from the
doc number. Only the human-readable number splits; the chain stays one
continuous per-CSID chain on the unified base.
