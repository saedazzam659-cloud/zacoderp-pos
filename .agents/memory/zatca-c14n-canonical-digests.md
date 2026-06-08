---
name: ZATCA digest/signature scopes — what is C14N'd (corrected by LIVE feedback)
description: Which ZATCA Reference is canonicalized vs hashed, what SignatureValue signs, the QR tag-8 source — and the hard lesson that live gateway feedback beats any single reference-SDK reading.
---

# ZATCA Phase-2 crypto scopes — verified against the LIVE compliance gateway

There are FOUR crypto sites. The values below are the **proven-passing** ones:
under them, company ZTC-26's STANDARD invoice/credit/debit samples PASSED the
live الفحص التجريبي (the gateway then returns `406 "Submitted before — Compliance
check already completed"`, which is itself proof they passed).

## 1. Reference#1 — invoice DigestValue → C14N over the whole body
`sha256( C14N11( invoice with the 3 enveloped-signature transforms applied ) )`:
remove `ext:UBLExtensions`, remove `cac:Signature`, remove the
`cac:AdditionalDocumentReference` whose `cbc:ID` = `QR`, then canonicalize the
WHOLE remaining document. Lives in `zatca-xml.ts hashXml`.

## 2. Reference#2 — SignedProperties DigestValue → C14N the fragment IN ISOLATION
`sha256( C14N( xades:SignedProperties as a self-contained fragment ), utf8 )`,
via `canonicalizeFragment(signedProps, "SignedProperties")`. Only the namespaces
declared inside the fragment appear (xades on the apex + ds inline on each ds
child), NOT the invoice-root 9-ns set, and NOT a raw template hash.

## 3. SignatureValue → ECDSA-SHA256 over C14N(ds:SignedInfo), P1363 encoding
`canonicalizeFragment(signedInfo, "SignedInfo")` → `createSign("SHA256")` →
`.sign({ key, dsaEncoding: "ieee-p1363" })` (fixed-length r||s, NOT DER). BR-KSA-30
also needs a `cac:Signature` block in the body (stripped by the Reference#1
transform, so it doesn't affect the invoice hash).

## 4. QR (TLV) tag sources
- tag 7 = the base64 SignatureValue STRING as utf8 bytes.
- tag 8 = SubjectPublicKeyInfo DER derived from the EGS PRIVATE key
  (`publicKeySpkiDer` = createPublicKey(createPrivateKey(pem)).export spki/der).
- tag 9 = the certificate's own signature bytes (`certSignatureFromDer`).

## QR-injection invariant (independent of the above)
Because the Reference#1 transform strips the QR AdditionalDocumentReference, the
invoice hash is identical with or without the Phase-2 QR — that is what lets the
pipeline `generate(empty QR) → hash → sign → buildPhase2Qr → injectQr` run
without invalidating the signature.

## HARD LESSON — live gateway feedback OVERRIDES any single reference-SDK reading
A reading of `wes4m/zatca-xml-js` suggested #2 should be a RAW hash (self-closing
`<ds:DigestMethod/>`) and #3 should sign the invoice-hash bytes in DER. Both were
applied and **the live gateway rejected the simplified samples with
`signed-properties-hashing`**, while the C14N versions above had already PASSED
the standard samples.
**Why:** an architect / code review CANNOT see the live ZATCA validator; one SDK's
template can differ from what the gateway actually recomputes.
**How to apply:** when a crypto-scope change "looks right" from a reference repo
but the live الفحص returns `signed-properties-hashing` / a signature error, that
change is a regression — revert to the scope that the gateway already accepted.
Never re-canonicalize-vs-raw flip-flop on reasoning alone; trust the gateway.

## "Submitted before" = PASS (compliance aggregation)
ZATCA returns `HTTP 406` + error code `"Submitted before"` ("Compliance check
already completed for <type>") once a document type has passed — it short-circuits
and does NOT re-validate. `zatca-compliance.ts` strips that pseudo-error and counts
the doc as `ok`, so all six types can complete and the company can obtain its PCSID.
