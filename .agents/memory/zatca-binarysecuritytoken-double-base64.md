---
name: ZATCA binarySecurityToken is double-base64 over the DER
description: Why cert parsing/signing must unwrap an extra base64 layer, and the exact ZATCA cert-digest formula
---

# ZATCA binarySecurityToken double-base64

ZATCA's CSID/PCSID response returns the certificate as a `binarySecurityToken`,
stored verbatim in `company.zatcaCsidToken` / `zatcaPcsidToken`. That token is
base64 **over the base64 cert body** — i.e. one EXTRA base64 layer relative to
the raw DER. Decoding it once yields ASCII base64 text (starts with `M`/`0x4D`),
NOT DER (which always starts with `0x30` SEQUENCE).

**Why it bit us:** `forge.asn1.fromDer` fed the single-decoded bytes throws
`"Unparsed DER bytes remain after ASN.1 parsing."` In `signZatcaUbl` the throwing
call (`parseCertIssuerSerial`) had no try/catch → HTTP 500 on every
compliance-check / submit, before ever reaching ZATCA. The sibling
`certSignatureDer` swallowed the same error via try/catch, so QR tag 9 was
silently empty. The defect lived in the "real X.509 parsing" code from the start;
it just wasn't exercised end-to-end until a company tried the live test.

**How to apply:** any place that parses the stored cert as DER must unwrap first.
Use the shared `certDerFromToken(token)` in `lib/zatca-xades-signer.ts`: strip PEM
armor, base64-decode once, and if `der[0] !== 0x30` decode the extra layer. It is
a no-op for already-DER/PEM input (runtime-verified for single- and double-encoded
forms). The `<ds:X509Certificate>` content must be the canonical single-base64
`der.toString("base64")`, never the raw double-encoded token.

**Do NOT touch the auth header:** ZATCA Basic auth username is the RAW
`binarySecurityToken` (`Basic base64(token:secret)`), not the unwrapped body.

**Cert digest formula (ZATCA-specific, NOT generic XAdES):**
`CertDigest = base64( lower-hex( sha256( base64-cert-body ASCII ) ) )`.
The hash is over the base64 cert STRING (the exact `<ds:X509Certificate>` text),
then the 64-char hex of the digest is base64-encoded → an 88-char value, not the
44-char `base64(sha256(DER))` of generic XAdES. Matches the official ZATCA SDKs
(Java `base64(DigestUtils.sha256Hex(cert).getBytes())`; Python
`base64(sha256(cert).hexdigest())`). A reviewer suggesting `base64(sha256(DER))`
is applying generic XAdES and is wrong for ZATCA.
