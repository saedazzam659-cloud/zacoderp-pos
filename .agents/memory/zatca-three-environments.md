---
name: ZATCA three self-contained environments
description: ZATCA onboarding/clearance has 3 separate gateways (sandbox/simulation/production), each hosting the FULL endpoint set with its own CSR template; never share a base URL across phases.
---

# ZATCA has THREE self-contained environments, not a "test vs live" toggle

ZATCA fatoora exposes three fully independent gateways under
`https://gw-fatoora.zatca.gov.sa/e-invoicing/`:

| env        | path segment       | CSR `commonName`/profile template |
|------------|--------------------|-----------------------------------|
| sandbox    | `developer-portal` | `TSTZATCA-Code-Signing`           |
| simulation | `simulation`       | `PREZATCA-Code-Signing`           |
| production | `core`             | `ZATCA-Code-Signing`              |

**Each gateway hosts the FULL onboarding chain** — `/compliance`,
`/compliance/invoices`, AND `/production/csids` all exist on `core` (production)
too. Verified empirically: `POST .../core/compliance` returns **400
"Missing-OTP"** (endpoint exists), NOT 404. To get a real Production CSID you
MUST run the compliance check on the **production** gateway first — there is no
"do compliance on sandbox then go live on core" shortcut; a CSID issued on one
gateway is rejected ("You are not authorized to use this api endpoint") by
another.

**Past incident (the 2-day bug):** an earlier memory + code comment wrongly
claimed `core` has no `/compliance` and 404s, so the auto-compliance route
blocked production entirely. Combined with the wrong invoice path (see
`zatca-compliance-invoices-endpoint.md`), compliance never completed and
`/production/csids` kept returning 401.

**How to apply:**
- Authoritative selector is `companies.zatca_environment`
  (`sandbox|simulation|production`), resolved by `resolveZatcaEnv(company)` in
  `routes/zatca.ts`; falls back to legacy `isSandbox` when null.
- Every ZATCA HTTP call computes its base URL from the resolved env via
  `getZatcaBaseUrl(env)`. Never branch a ZATCA URL on `isSandbox` directly.
- The whole chain (CSR → compliance CSID → compliance check → production CSID)
  must run end-to-end on ONE environment.
- CSR template differs per env — wrong template = gateway rejection. See
  `zatca-csr-spec.md`.
