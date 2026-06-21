---
name: ZATCA SignedProperties Reference#2 digest is C14N, not verbatim
description: Why the simplified (B2C) ZATCA sample fails signed-properties-hashing — the SignedProperties Reference#2 digest must be the C14N form, not a verbatim sha256 of the template; clearance is lenient and hides the bug.
---

# Simplified (B2C) `signed-properties-hashing`: digest must be C14N, not verbatim

Simplified samples fail `signed-properties-hashing` ("Invalid signed properties
hashing, SignedProperties with id='xadesSignedProperties'") while standard samples
pass. The SignedProperties content is invoice-independent, so the difference is NOT
the data — it is that the **reporting (simplified) validator strictly recomputes
the Reference#2 digest, while the clearance (standard) validator is lenient and
accepts a wrong one.** Standard CLEARED is therefore NOT proof the digest is right.

## The decisive rule (from XML-DSIG, confirmed by the live gateway)
`SignedInfo`'s Reference#2 is `URI="#xadesSignedProperties"` and carries **NO
`<ds:Transforms>`**. Per XML-DSIG, a same-document reference with no explicit
transform is dereferenced to a node-set and **canonicalized with the default
Canonical XML (C14N)** before hashing. So ZATCA computes
`sha256( C14N(SignedProperties) )`, NOT `sha256(verbatim template)`.

C14N changes two things our template gets wrong:
1. **Namespace decls sort before attributes** → apex becomes
   `<xades:SignedProperties xmlns:xades="…" Id="xadesSignedProperties">` (our
   template authored `Id` first).
2. **Self-closing tags expand** → `<ds:DigestMethod …/>` becomes
   `<ds:DigestMethod …></ds:DigestMethod>` (and `xmlns:ds` sorts before
   `Algorithm`).

Verbatim sha256 of the template differs from C14N at exactly these points →
`signed-properties-hashing` on the strict path.

**Fix:** hash `canonicalizeFragment(signedProps, "SignedProperties")`. The helper
parses the fragment standalone, so only its own xades/ds namespaces appear — NO
phantom invoice-root (cac/cbc/ext/…) namespaces. (An older bug wrapped the
fragment in the invoice's 9-ns root, injecting 8 phantom namespaces — that ALSO
caused `signed-properties-hashing`. Standalone C14N avoids both failure modes.)
Leave `SignedInfo`/SignatureValue alone — it already C14Ns via canonicalizeFragment
and standard passes.

**Why this is not a reasoning-only flip-flop:** the verbatim approach was live on
production and FAILED simplified with signed-properties-hashing — that is gateway
feedback, not a guess. The C14N isolation form is the one documented as
live-verified passing (see `zatca-c14n-canonical-digests.md` #2).

## QR tag 8 (separate concern — currently OK)
When simplified ALSO fails `publicKey_QRCODE_INVALID`, QR tag 8 must be the CERT's
SubjectPublicKeyInfo (use `certPublicKeySpkiDer`), not SPKI re-derived from the
private key (Node can emit EXPLICIT EC params instead of the named secp256k1 OID →
byte mismatch). In the company-26 production run there was NO publicKey error, so
tag 8 was already correct — do not touch it to "fix" a hashing-only failure.

## Scope note
`pos-desktop`'s signer (`src/lib/zatca/xades.ts`) is byte-identical to the web
api-server signer and STILL hashes SignedProperties verbatim — same latent bug. It
needs the same C14N fix before it can pass simplified, but that is a separate
Windows-app release (version bump + tag) and out of scope for web onboarding.
