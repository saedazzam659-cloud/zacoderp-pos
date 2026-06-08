---
name: ZATCA EC cert vs node-forge RSA-only
description: Why ZATCA certificate parsing must avoid forge.pki.certificateFromAsn1 and walk ASN.1 directly
---

ZATCA certificates (CSID/PCSID, and the `binarySecurityToken`) are **ECDSA secp256k1**, not RSA.

`forge.pki.certificateFromAsn1(asn1)` eagerly parses the SubjectPublicKeyInfo as RSA and throws
**`Cannot read public key. OID is not RSA.`** on any EC cert — a 500 if it's on a request path.

**Rule:** never build a full forge certificate object from a ZATCA cert. Walk the ASN.1 yourself and
take only what you need (issuer Name, serialNumber, signatureValue). The public key is irrelevant for
the XAdES SigningCertificate / QR tags.

**How to apply (the working parse):**
- `forge.asn1.fromDer(...)` works fine on EC DER — it's only `certificateFromAsn1` that fails.
- Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }.
- TBSCertificate ::= SEQUENCE { version [0] EXPLICIT *optional*, serialNumber, sigAlg, issuer, … }.
  Detect the optional version: `tbs.value[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && type===0`
  → serial at index 1, else 0. Real ZATCA certs are v3 so version IS present (serial at idx 1, issuer at idx 3).
- Issuer Name → `forge.pki.RDNAttributesAsArray(issuerAsn1)` (exists at RUNTIME but missing from
  `@types/node-forge` → needs a cast). Reuse the existing shortMap/escape/**reverse** (DER order is
  CA-general-first / CN-last; reverse for RFC 4514 CN-first to match openssl `-nameopt RFC2253`).
- serialNumber → `forge.util.bytesToHex(serialAsn1.value)` → strip leading zeros → `BigInt("0x"+hex).toString(10)`.
- Cert signature (QR **tag 9**) = `Certificate.value[2]` BIT STRING. forge **auto-decodes** the BIT
  STRING into the inner ECDSA `SEQUENCE{r,s}` (so `.value` is an ARRAY, not a string) → re-serialize
  with `forge.asn1.toDer(sigBits.value[0]).getBytes()`. If `.value` is a raw string instead, drop the
  leading `0x00` unused-bits octet. Result starts `0x30` (DER ECDSA sig).

**Verify without a live cert:** `openssl ecparam -name secp256k1 -genkey -noout -out ec.key` then
`openssl req -new -x509 -key ec.key -subj "/DC=local/DC=gov/DC=extgazt/CN=PRZEINVOICESCA4-CA"` (note:
real ZATCA DER order is DC-first/CN-last). Compare your parse to
`openssl x509 -noout -issuer -serial -nameopt RFC2253` and the `Signature Value` block.

**Why:** company ZTC-26 compliance-check 500'd on this AFTER the double-base64 DER fix (see
`zatca-binarysecuritytoken-double-base64.md`); the two are independent layers — fix order was decode → EC parse.
Lives in `parseCertIssuerSerial` + exported `certSignatureFromDer` in `zatca-xades-signer.ts`, consumed by
`certSignatureDer` in `zatca-build-signed.ts`.
