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
  xades:SignedProperties **in context**))`.
- `signature-method` — SignatureValue must sign `C14N(ds:SignedInfo **in context**)`.

**Why "in context" matters:** inclusive C14N renders EVERY in-scope namespace on the
apex of the canonicalized subset — including the unused default `xmlns="…Invoice-2"`
and all 9 namespaces declared on `<Invoice>`. A fragment serialized on its own only
declares its own 1–2 namespaces, so its canonical form differs from what ZATCA gets
when it canonicalizes that same node inside the assembled invoice. Reproduce the
context by wrapping the fragment under a synthetic `<Invoice>` that declares the same
9 namespaces — C14N output depends only on the node subtree + in-scope namespaces.

## The xml-crypto trap (this was the actual bug)

`new C14nCanonicalization().process(node, options)` **silently drops in-scope
ancestor namespaces** unless you pass `options.ancestorNamespaces`. Compute them with
`findAncestorNs(doc, xpathToNode)` (exported by `xml-crypto`) and pass them in.

- **Whole-document hash:** the document element IS the root, so it has no ancestors →
  call with **empty options** `process(root, {})`. Correct here.
- **Fragment digest/signature (SignedProperties / SignedInfo):** MUST pass
  `{ ancestorNamespaces: findAncestorNs(doc, expr) }` or the default + sibling
  namespaces vanish and ZATCA rejects the digest/signature.

**Why:** empty-options was the original bug — it produced fragments missing 7 of the
9 namespaces on the apex.
**How to apply:** any new ZATCA digest/signature site goes through
`lib/zatca-c14n.ts` (`canonicalizeInvoiceForHash` for the invoice hash;
`canonicalizeInContext(fragmentXml, "SignedProperties"|"SignedInfo")` for fragments).
Never re-introduce a plain `sha256(rawString)` for any ZATCA Reference.

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
