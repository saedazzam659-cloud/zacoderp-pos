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
