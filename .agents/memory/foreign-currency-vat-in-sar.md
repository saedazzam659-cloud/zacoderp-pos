---
name: Foreign-currency tax invoices must show VAT in SAR
description: ZATCA compliance rule for sales document printing when currency != SAR
---

# Foreign-currency tax invoices must display the VAT amount in SAR

When a **tax document** (sales invoice or sales return) is issued in a foreign
currency, the print MUST also show the VAT amount converted to the base currency
(SAR). We additionally surface the grand total in SAR and the exchange-rate line.

**Why:** ZATCA / KSA VAT regulation requires the VAT amount on a foreign-currency
tax invoice to be expressed in SAR. Showing only the exchange rate is not enough.

**How to apply:**
- Base = foreign × exchangeRate. The rate convention stored on the doc is
  "1 foreign = X SAR" (e.g. 1 USD = 3.75 SAR), so multiply, never divide.
- This is a **display-only** concern — no calculation, schema, or JE changes.
  All accounting is already booked in SAR.
- Gate it to tax documents only: quotations and sales orders are NOT tax
  documents and must NOT show the SAR-equivalent block. SAR-denominated docs
  also show nothing (no conversion needed).
- In the sales print layer the gating lives in one place (a `showSarEq` flag on
  the computed totals = foreign AND tax-doc); the print TYPE is resolved from an
  explicit arg or a value stamped onto the doc before any template renders. Any
  NEW print template that builds its own totals rows must splice in the shared
  SAR-equivalent renderer, or it will silently omit the required SAR VAT line.
