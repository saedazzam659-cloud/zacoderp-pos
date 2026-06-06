---
name: ZATCA CSR must follow the official csr.cnf layout
description: The CSR for ZATCA onboarding (/compliance) needs specific template name + dirName SAN; a DigiCert-OID/URI CSR is rejected with 400.
---

# ZATCA CSR generation

ZATCA's `/compliance` endpoint rejects a CSR with HTTP 400 unless it matches the
official `csr.cnf` layout. A symptom: **zero** companies ever obtain a CSID
(`zatca_csid` always NULL) even though `generate-csr` succeeds — because the CSR
is structurally wrong, not the OTP/environment.

**Why:** an earlier generator used DigiCert OIDs (`2.16.840.1.114028.10.1.*`) and
a `URI=<vat>` subjectAltName, plus a made-up template name
(`ZATCA_E-Invoice_Solutions_Provider`). ZATCA validates the certificate-template
name and expects the EGS attributes inside a directoryName SAN — neither matched,
so every onboarding attempt 400'd.

**How to apply:** the CSR must contain
- OID `1.3.6.1.4.1.311.20.2` = the exact template name:
  - production (core) → `ZATCA-Code-Signing`
  - simulation → `PREZATCA-Code-Signing`
  - sandbox / developer-portal → `TSTZATCA-Code-Signing`
- `subjectAltName = dirName:dir_sect` holding: `SN` (EGS serial `1-..|2-..|3-..`),
  `UID` (15-digit VAT/org identifier), `title` (invoice-type flags — `1100` both,
  `1000` standard-only, `0100` simplified-only), `registeredAddress`,
  `businessCategory` (must be non-empty).
- EC key `secp256k1`, `default_md sha256`.

Verify locally without ZATCA: build the CSR and run
`openssl req -in x.csr -noout -text` — confirm the template string and the
`DirName:/SN=.../UID=.../title=.../registeredAddress=.../businessCategory=...`
SAN are present.

Operational note: the broken CSR is **persisted** in `companies.zatca_csr`. After
fixing the generator you MUST re-run `generate-csr` for each company before
`/compliance`, and use a FRESH OTP (single-use, 1-hour). The compliance route
logs ZATCA's real rejection via `req.log.warn(... zatcaResponse ...)`.

The pos-desktop (Windows) standalone pipeline has its OWN separate CSR builder —
it is **TypeScript** (`src/lib/zatca/csr.ts`), a hand-rolled DER port, NOT Rust,
NOT openssl. It had the exact same bug (made-up template + URI SAN + DigiCert
OIDs) and was fixed to mirror this same spec. The desktop OTP/compliance/
production flow already existed and worked once the CSR was correct. The dirName
SAN must be a `[4]` constructed context tag wrapping the RDNSequence; all five
attribute values are UTF8String; the OIDs openssl uses for the csr.cnf short
names are: SN=2.5.4.4 (surname), UID=0.9.2342.19200300.100.1.1 (userId),
title=2.5.4.12, registeredAddress=2.5.4.26, businessCategory=2.5.4.15. Verify
the TS output the same way: `npx tsx` build a CSR → `openssl req -noout -text`.

## production-csid step

`POST /production/csids` body must be `{ compliance_request_id: <requestID> }`
where `<requestID>` is the value ZATCA returned from `/compliance` — NOT the
binarySecurityToken/CSID. There is no DB column for it on `companies`, so the
web flow round-trips it: the compliance response exposes `requestID`, the client
stores it (`localStorage zatca_compliance_reqid_<companyId>`) and forwards it as
`complianceRequestId` to the production-csid route. Using the token there 400s.

