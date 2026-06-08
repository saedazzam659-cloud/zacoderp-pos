---
name: ZATCA digests/signatures need C14N, not raw strings
description: Why ZATCA invoice-hash + XAdES signing must canonicalize (inclusive C14N) before hashing/signing, and the xml-crypto ancestorNamespaces trap that silently breaks it.
---

# ZATCA digests & signatures are computed over CANONICAL XML, never raw strings

ZATCA recomputes every digest and the signature over the **inclusive C14N (c14n11)**
canonical form of the relevant XML subset — NOT over the serialized template string.
Hashing/signing the raw string produces these compliance-test rejections:

- `invalid-invoice-hash` — Reference#1 DigestValue must be `sha256(C14N(invoice
  with the 3 enveloped-signature transforms applied))`: remove `ext:UBLExtensions`,
  remove `cac:Signature`, remove the `cac:AdditionalDocumentReference` whose
  `cbc:ID` text = `QR`. Then canonicalize the whole remaining document.
- `signed-properties-hashing` — Reference#2 DigestValue must be `sha256(C14N(
  xades:SignedProperties **in isolation**))` (NOT in document context).
- `signature-method` (BR-KSA-30) — TWO independent causes: (a) the invoice body must
  contain a `cac:Signature` block with
  `cbc:SignatureMethod = urn:oasis:names:specification:ubl:dsig:enveloped:xades`
  (the hash transform strips cac:Signature so it doesn't affect the invoice hash);
  and (b) the SignatureValue must sign `C14N(ds:SignedInfo **in isolation**)`.

**The two scopes are DIFFERENT — this is the whole subtlety:**

- **Whole-invoice hash (Reference#1):** canonicalize the WHOLE document (after the 3
  enveloped-signature transforms). Inclusive C14N keeps EVERY in-scope namespace —
  incl. the unused default `xmlns="…Invoice-2"` and all 9 declared on `<Invoice>` —
  on the apex. The documentElement is the root (no ancestors) → `process(root, {})`.

- **XAdES fragment digests (Reference#2 SignedProperties + the SignatureValue over
  SignedInfo):** ZATCA canonicalizes the referenced element **IN ISOLATION**, NOT in
  the assembled-document context. The correct canonical form contains ONLY the
  namespaces declared inside the fragment itself:
  - SignedProperties → `xmlns:xades` on the apex + `xmlns:ds` repeated inline on each
    of the 4 ds children (DigestMethod/DigestValue/X509IssuerName/X509SerialNumber).
    NO cac/cbc/ext/sig/sac/sbc, NO default xmlns.
  - SignedInfo → `xmlns:ds` on the apex only.
  The signer templates are authored self-contained for exactly this, so the fix is
  to parse the fragment ALONE and `process(documentElement, {})` — same call as the
  whole-doc hash, just on the isolated fragment.

**The bug that wasted a cycle:** wrapping each fragment under a synthetic 9-ns
`<Invoice>` (to "reproduce context") and/or passing
`ancestorNamespaces: findAncestorNs(...)` injects 8 phantom namespaces onto the
fragment apex → `signed-properties-hashing`. ZATCA does NOT want document context
for these references. Do NOT wrap; do NOT use findAncestorNs for the fragments.

**How to apply:** any new ZATCA digest/signature site goes through
`lib/zatca-c14n.ts` — `canonicalizeInvoiceForHash` for the invoice hash;
`canonicalizeFragment(fragmentXml, "SignedProperties"|"SignedInfo")` for the XAdES
fragments (standalone, no wrapper). Never re-introduce a plain `sha256(rawString)`
for any ZATCA Reference. Verify with: SignedProperties canonical must have exactly
4× `xmlns:ds` and zero invoice-root ns; SignedInfo must be ds-only apex.

## Stable-across-QR-injection invariant

Because the invoice-hash transform strips the QR `AdditionalDocumentReference`, the
hash is identical whether or not the Phase-2 QR has been injected. That is exactly
what lets the pipeline sign first and inject the QR afterward
(`generate(empty QR) → hash → sign → buildPhase2Qr → injectQr`) without invalidating
the signature. Verified empirically: two invoices differing only in QR payload
produce the identical invoice hash.

## Shared by both pipelines

Web (`zatca-xml.ts hashXml` + `zatca-xades-signer.ts`) and pos-desktop (`ubl.ts`)
historically BOTH hashed raw strings — the "pos-desktop already works" assumption was
false for the hash. The XAdES SignedInfo/SignedProperties templates are byte-identical
between the two. If you fix one, mirror the C14N fix in the other.
