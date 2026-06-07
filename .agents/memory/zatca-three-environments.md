---
name: ZATCA three self-contained environments
description: ZATCA onboarding/clearance has 3 separate gateways (sandbox/simulation/production), each hosting ALL endpoints with its own CSR template; never share a base URL across phases.
---

# ZATCA has THREE self-contained environments, not a "test vs live" toggle

ZATCA fatoora exposes three fully independent gateways under
`https://gw-fatoora.zatca.gov.sa/e-invoicing/`:

| env        | path segment       | CSR `commonName`/profile template |
|------------|--------------------|-----------------------------------|
| sandbox    | `developer-portal` | `TSTZATCA-Code-Signing`           |
| simulation | `simulation`       | `PREZATCA-Code-Signing`           |
| production | `core`             | `ZATCA-Code-Signing`              |

**Why this matters / past incident:** the app originally modelled this as a
single `isSandbox` boolean → only `developer-portal` (sandbox) and `core`
(production). Real production onboarding broke because the **production `core`
gateway does NOT host the `/compliance/...` onboarding endpoints** — they live
on `developer-portal` and `simulation` only, and `core` returns 404. There is
no "run compliance on production" path; compliance is always done on
sandbox/simulation, then you go live on `core`.

**How to apply:**
- The authoritative selector is `companies.zatca_environment`
  (`sandbox|simulation|production`), resolved by `resolveZatcaEnv(company)` in
  `routes/zatca.ts`; it falls back to the legacy `isSandbox` boolean when the
  column is null.
- Every ZATCA HTTP call (generate-csr/compliance/production-csid/
  compliance-check/submit) must compute its base URL from the resolved env via
  `getZatcaBaseUrl(env)`. Never branch a ZATCA URL on `isSandbox` directly.
- Legacy `isSandbox` is kept in sync as `env !== "production"`, so **simulation
  is isSandbox=true** (only production is "live"). Don't treat isSandbox=true as
  "sandbox env" — it can mean simulation.
- The CSR template differs per env — picking the wrong template gets rejected by
  the gateway. See `zatca-csr-spec.md` for the exact CSR/dirName SAN rules.
