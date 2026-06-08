---
name: ZATCA invoice hash is over the empty-QR XML
description: The exact build/sign/hash order ZATCA requires; the bug that produced "invalid-invoice-hash".
---

ZATCA computes the invoice DigestValue / hash over the UBL XML **excluding** the
QR (and the UBLExtensions/Signature it injects). If you bake a Phase-1/Phase-2
QR into the XML BEFORE hashing and hash that string, the gateway's recomputed
hash won't match → compliance test fails with `invalid-invoice-hash`, and live
submit is rejected.

**Correct sequence (the one the working pos-desktop pipeline uses):**
1. `generateZatcaXml` with an EMPTY QR placeholder.
2. `hashXml` the empty-QR document → this is the `invoiceHash` you store + send.
3. `signZatcaUbl` (signs over that same canonical doc).
4. `buildPhase2Qr` (TLV, includes the signature/cert).
5. `injectQr` to put the QR into the final signed XML.
6. Store the SIGNED finalXml as `xmlContent`; send `{ invoiceHash, invoice:
   base64(finalXml) }`.

**How to apply:** this lives in the shared `lib/zatca-build-signed.ts`
(`buildSignedZatcaInvoice`). Every submission path (web /issue, compliance
check, live submit, sales-invoice bridge) MUST build through it and send the
STORED signed xml + stored hash — never re-hash a stored QR-containing string,
and never hash after injecting the QR.
