---
name: ZATCA SignedProperties Reference#2 digest = base64-of-hex of the C14N form
description: Why the simplified (B2C) ZATCA sample fails signed-properties-hashing — the SignedProperties Reference#2 DigestValue must be base64(lower-hex(sha256(C14N))), the same base64-of-hex quirk as the cert digest, NOT raw-bytes base64. C14N alone does not fix it.
---

# Simplified (B2C) `signed-properties-hashing`: digest = base64-OF-HEX of C14N

Simplified samples fail `signed-properties-hashing` ("Invalid signed properties
hashing, SignedProperties with id='xadesSignedProperties'") while standard samples
"pass". The content is invoice-independent, so it is NOT the data. Two things must
BOTH be right; getting only one still fails the strict reporting/simplified path:

## 1. Content = C14N of the SignedProperties fragment (necessary, not sufficient)
Reference#2 is `URI="#xadesSignedProperties"` with **NO `<ds:Transforms>`** → per
XML-DSIG a same-document reference is dereferenced to a node-set and C14N'd before
hashing. So the bytes hashed are `canonicalizeFragment(signedProps,
"SignedProperties")` (xmlns sorts before Id; self-closing tags expand), parsed
standalone so only its own xades/ds namespaces appear — NO phantom invoice-root
namespaces. (In-context C14N gives the **identical** hash to standalone here, so
inherited xmlns:ds is a non-issue.)

## 2. Encoding = base64-OF-HEX (the decisive fix)
**The DigestValue is `base64( lower-hex( sha256( C14N ) ) )` — base64 of the
64-char hex STRING, ~88 chars — NOT `sha256(...).digest("base64")` (raw 32 bytes,
44 chars).** This is the SAME ZATCA reference-impl quirk used for the **cert
digest** (`zatca-binarysecuritytoken-double-base64.md`) and matches zatca-xml-js
`getSignedPropertiesHash` (`createHash.update(xml).digest("hex")` →
`Buffer.from(hex).toString("base64")`).

**Why both verbatim AND C14N failed identically on production:** both used
`.digest("base64")` (raw bytes). The canonicalization was a red herring — the real
mismatch was the encoding. Switching to base64-of-hex (mirroring the cert-digest
lines right above in the signer) is the actual fix.

**Asymmetry that confirms it:** the invoice digest (Reference#1) is accepted as
plain raw-bytes base64 — only this XAdES Reference#2 uses base64-of-hex. So leave
Reference#1 and SignedInfo/SignatureValue alone; only the SignedProperties digest
encoding was wrong.

**Why this is gateway-confirmed, not a flip-flop:** verbatim+raw-base64 FAILED
simplified live; C14N+raw-base64 FAILED simplified live with the byte-identical
error. Both were real production feedback. base64-of-hex is the encoding the cert
digest already uses successfully on the same gateway.

## QR tag 8 (separate concern — currently OK)
When simplified ALSO fails `publicKey_QRCODE_INVALID`, QR tag 8 must be the CERT's
SubjectPublicKeyInfo (`certPublicKeySpkiDer`), not SPKI re-derived from the private
key. If the failing run shows ONLY a hashing error and no publicKey error, tag 8 is
already correct — do not touch it to "fix" a hashing-only failure.

## Scope note
`pos-desktop`'s signer (`src/lib/zatca/xades.ts`) is byte-identical and has BOTH
latent bugs (verbatim content + raw-base64 encoding). It needs the same two fixes
before it can pass simplified, but that is a separate Windows-app release (version
bump + tag) and out of scope for web onboarding.
