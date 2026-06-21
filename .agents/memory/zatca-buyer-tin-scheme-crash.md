---
name: ZATCA buyer PartyIdentification must not use schemeID="TIN"
description: Why the opaque GENERAL/BUSINESS_RULES "Unable to execute Business Rules validation ->" crash hits B2B invoices, and the structural cause.
---

# ZATCA buyer PartyIdentification scheme crash

A B2B (standard) tax invoice whose buyer carries a VAT number must put that VAT
number **only** in `cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID`.
It must **never** also be emitted as a `cac:PartyIdentification` with
`schemeID="TIN"`.

**Why:** ZATCA's valid buyer-ID schemes (BT-46-1) are
CRN/MOM/MLS/700/SAG/NAT/GCC/IQA/PAS/OTH. `TIN` is not in that list, so the
Schematron Business-Rules engine throws while evaluating the unexpected scheme
and the gateway returns the opaque, category-less error
`GENERAL / BUSINESS_RULES: "Unable to execute Business Rules validation ->"`
(no validationResults, no rule id). It only fires for B2B because B2C/simplified
buyers have no VAT number, so the bad block was never emitted.

**How it was proven:** controlled isolation experiment against the production
clearance gateway — submitted the failing invoice plus structural-removal
variants; removing the buyer `PartyIdentification schemeID="TIN"` was the ONLY
variant where the BR crash disappeared (errorMessages became `[]`). A re-signed,
corrected resubmit returned HTTP 202 `clearanceStatus=CLEARED`.

**How to apply:** in any UBL builder, the buyer's VAT/tax number goes in
PartyTaxScheme/CompanyID; PartyIdentification is for CRN/etc. only. When you see
the opaque GENERAL/BUSINESS_RULES crash with no validationResults on a B2B-only
subset, suspect an invalid buyer (or seller) `schemeID` first.

**Latent duplicate:** `artifacts/pos-desktop/src/lib/zatca/ubl.ts` has the SAME
buyer `schemeID="TIN"` block — its B2B invoices will crash identically. Not yet
fixed there because pos-desktop changes trigger an MSI release cycle.
