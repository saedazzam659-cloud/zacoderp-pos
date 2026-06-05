---
name: POS Desktop standalone ZATCA pipeline
description: How the Windows app onboards + signs + submits to ZATCA directly (no Zacod cloud), and the non-obvious chain/QR/hash rules.
---

The POS Desktop standalone ZATCA path (`src/lib/zatca/{native,gateway,onboarding,submit}.ts`
+ `pages/ZatcaOnboarding.tsx`) lets the device do the full EGS ladder itself:
CSR → compliance CSID (OTP) → compliance check → production CSID, then per-invoice
build → sign → submit. All confined to `artifacts/pos-desktop`; the cloud api-server is
never touched. Gated to country=="SA" via `isZatcaCountry()`.

**Record-before-submit is the chain invariant.** `buildAndSignInvoice` consumes the ICV
and persists the signed row (status `pending`) BEFORE `submitSigned` runs. A submit failure
must leave that row `pending` and never re-mint an ICV — retry re-submits the STORED
`signedXml`. `zatcaChainHead` returns the max-ICV row regardless of status, so a failed/
queued invoice still advances `pih`+`icv` for the next one. If you ever make submit
consume the ICV instead, two offline invoices collide on the same ICV and the chain forks.
**Why:** ZATCA's PIH chain must be gap-free and monotonic per device; the offline queue
depends on the chain advancing even when the network is down.

**QR is injected AFTER signing, into the empty element.** UBL is built with `qrCode=""`,
hashed (`hashUbl` = whole-string sha256 b64, same non-spec C14N caveat as the cloud),
signed (XAdES only rewrites `<ext:UBLExtensions>`, leaving the QR element intact and empty),
then the Phase-2 QR is regex-injected into the ONLY empty
`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain"></...>`. The PIH
AdditionalDocumentReference uses the SAME element type but is NON-empty (holds the previous
hash), so a non-global `.replace` matching `>(</...)` only ever hits the QR one.
**Why:** the QR is spec-excluded from the digest transforms; injecting post-signature keeps
the signed bytes stable. Don't switch to a global replace or you'll clobber the PIH element.

**Genesis PIH is a different length on purpose.** First invoice uses the ZATCA-documented
constant `GENESIS_PIH` (base64 of the ASCII hex of sha256("0") — 88 chars); every later
invoice chains on the previous invoice's DigestValue (base64 of the raw 32-byte hash —
44 chars). The length mismatch is expected, not a bug.

**Credentials/secrets:** private key stored hex in keyring slot `privkey`; compliance +
production CSIDs as JSON `{token,secret}` in their own slots. `loadActiveCredentials` prefers
the production CSID, falling back to compliance (used during compliance checks). The ZATCA
`binarySecurityToken` is bare base64 — passed directly as `certificatePem` to the signer AND
b64-decoded for the QR tag-9 cert signature. Clearing a slot writes `""` → `JSON.parse`
throws → treated as absent.

**Submit error taxonomy:** a thrown `zatca_https_post` (no connectivity/TLS) → row stays
`pending` (offline queue); an HTTP non-2xx with a body → row `rejected` with the validation
payload. CSID issuance (gateway) THROWS on non-2xx so onboarding can surface the Arabic error.
