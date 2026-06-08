---
name: ZATCA SignedProperties verbatim + QR tag8 from cert
description: The two divergences that fail simplified (B2C) ZATCA compliance — SignedProperties digest must be verbatim, QR tag8 must come from the cert SPKI
---

# Simplified (B2C) compliance: SignedProperties digest + QR tag 8

ZATCA simplified samples fail with TWO errors that standard (B2B) samples don't surface:
`publicKey_QRCODE_INVALID` and `signed-properties-hashing`. Both are signer bugs, not data bugs.

## Rule 1 — SignedProperties Reference#2 digest is hashed VERBATIM, never C14N
The `<xades:SignedProperties>` Reference digest must be `sha256(verbatim template string)`.
Running the template through xml-crypto C14N (`canonicalizeFragment`) reorders attributes
(`xmlns:xades` before `Id`) and expands self-closing tags → different bytes → `signed-properties-hashing`.
**Why:** ZATCA recomputes this digest over the literal SignedProperties serialization, and the
template is authored to match that byte-for-byte. The proven offline POS signer hashes verbatim.
**How to apply:** Only the SignedProperties Reference digest is verbatim. `SignedInfo` (the
SignatureValue source) is STILL signed over its C14N form — that path is accepted by ZATCA, leave it.
The two are independent crypto sites; do not "unify" them.

## Rule 2 — QR tag 8 (EGS public key) must be the CERT's SubjectPublicKeyInfo, not derived from the private key
Deriving SPKI from the private key via Node `createPublicKey(...).export({type:'spki'})` can emit
the EC domain params in EXPLICIT form (full prime/a/b/generator) instead of the named secp256k1
curve OID when the stored key carries explicit params — bytes differ from the cert's named-curve
SPKI even though the point is identical → `publicKey_QRCODE_INVALID`.
**Why:** ZATCA byte-compares tag 8 against the public key inside the signing certificate.
**How to apply:** Extract SPKI straight out of the cert DER (`tbsItems[idx+5]`, idx skips optional
`[0]` EXPLICIT version) and use those bytes. Guaranteed match regardless of key param encoding.

## Scope note
These live in the single source of truth `buildSignedZatcaInvoice` / `signZatcaUbl` (web api-server).
The offline `pos-desktop` signer is the proven reference (it was a port of the cloud signer that
later diverged). Do NOT touch invoice-hash, cert-digest, SignedInfo, or tag 9 — all accepted as-is.
