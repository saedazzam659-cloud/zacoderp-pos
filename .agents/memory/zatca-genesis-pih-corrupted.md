---
name: ZATCA genesis PIH was corrupted
description: The hardcoded first-invoice genesis Previous-Invoice-Hash constant did not equal sha256("0"); fix + why it matters.
---

# ZATCA genesis PIH constant was wrong

The first-document-in-chain Previous-Invoice-Hash (PIH) must be the base64 of the
**hex** SHA-256 digest of the ASCII string `"0"`:

- Correct hex: `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`
- Correct base64 (what goes in the XML / DB): `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==`

The codebase shipped a **corrupted** constant that decoded to
`5feceb66ffc86f38d952786f5299b16b6f4b2e266909030b37adfb3574b492b4`
(same first ~22 hex chars, then garbage — looks like a hand-transcription error).
It was duplicated under the name `GENESIS_HASH` in THREE places:
`lib/zatca-env.ts` (exported, used by routes/sales.ts + routes/zatca.ts),
`routes/invoices.ts`, and `lib/zatca-compliance.ts`.

**Symptom:** ZATCA clearance/reporting of a first-in-chain invoice returns XSD
PASS but `validationResults.errorMessages = [{code:"GENERAL", category:"BUSINESS_RULES",
message:"Unable to execute Business Rules validation ->", status:ERROR}]`,
clearanceStatus NOT_CLEARED, HTTP 400. That generic GENERAL/"-> (empty)" message
is an SDK *exception*, not a specific BR code — a wrong genesis PIH is a prime
suspect for it.

**Why it went unnoticed:** at the time of the fix, NO invoice for ANY company had
ever cleared with a persisted `invoice_hash`/`icv` (every sales_invoices row was
pending/rejected, or `approved` with no hash). So the genesis was only ever used,
never validated-and-accepted. Because no chain depended on the old value, fixing
the constant is safe across all tenants — genesis only applies to a company's
FIRST clearance; subsequent invoices chain off the persisted prior hash.

**How to apply:** if a first invoice fails BR validation with the generic GENERAL
message, verify the embedded PIH equals base64(hex(sha256("0"))) before chasing
totals/party/signature. Keep all genesis constants in lockstep (ideally one
exported source).

**IMPORTANT — genesis was NOT the cause of the GENERAL error (confirmed after
prod redeploy):** company ZTC-26 (id 26) invoice 160 (standard/clearance,
158,700 SAR) was re-signed in production with the *corrected* genesis embedded
(verified: embedded PIH decoded to `...786c6d696c79...`) and ZATCA returned the
**identical** `GENERAL / "Unable to execute Business Rules validation ->"` (HTTP
400, NOT_CLEARED). So the corrupted genesis was a real but **independent** bug;
this opaque GENERAL exception has a different root cause that is still
**unconfirmed**. Ruled out so far: XSD passes; totals reconcile; both parties +
Delivery + PaymentMeans present; ProfileID=reporting:1.0 with InvoiceTypeCode
0100000 (correct for standard); cert is a genuine **production PCSID** (issuer
PRZEINVOICESCA4-CA, subject EGS serial `1-ACTITECINTERNATIONAL|2-LIC-000026|3-…`,
authenticates with no 401); internal hash chain self-consistent (Reference#1
DigestValue == QR tag6; SignedProperties/CertDigest use the base64(hex) ZATCA
convention; SignatureValue ECDSA-SHA256 / ieee-p1363 over C14N11 SignedInfo).
**Systemic, not per-invoice:** across ALL companies, ZERO invoices have ever been
cleared/reported and ZERO have a persisted `invoice_hash` — production clearance
has never once succeeded end-to-end. Leading remaining suspect: a
canonicalization mismatch between our `canonicalizeFragment`/hash pipeline and
ZATCA's gateway (which recomputes independently), making the gateway's
signature/hash verification throw. Next debugger should verify the ECDSA
signature against ZATCA's own C14N of SignedInfo, and confirm the invoice-hash
recomputation matches the gateway's, rather than re-checking visible XML content.
