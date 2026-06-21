---
name: ZATCA CSID issuer is NOT a reliable environment discriminator
description: Why the compliance CSID issuer is always CN=eInvoicing (every env), and why an issuer-based env guard wrongly blocks production onboarding.
---

# ZATCA compliance CSID issuer is `CN=eInvoicing` in EVERY environment

**Corrects an earlier misdiagnosis.** The ZATCA **compliance** certificate
(`zatca_csid_token`, obtained from `/compliance`) is issued by ZATCA's compliance
CA whose issuer CN is the bare **`CN=eInvoicing`** in *all three* environments —
sandbox (developer-portal), simulation, AND production (`core`). So the issuer CN
**cannot** tell you which gateway minted a *compliance* cert.

**Verified live on the production `core` gateway:**
- `POST /companies/:id/compliance` against the production `core` gateway with a
  production-portal OTP → HTTP 200, `dispositionMessage: "ISSUED"`. The issued
  cert's issuer is `eInvoicing`.
- `POST /companies/:id/production-csid` then reached production `/production/csids`,
  which **accepted that cert's Basic auth** and returned a structured business
  reply `Missing-ComplianceSteps [standard-compliant, …]` — **not** a 401. Auth
  was accepted; it just wanted the sample documents first.
- An earlier manual compliance-check on production returned a **business-rules
  400** ("Unable to execute Business Rules validation"), again **not** a 401.

**Conclusion:** there is no observed "wrong-environment 401" for an `eInvoicing`
compliance cert on the production gateway. The previous belief that "eInvoicing
issuer ⇒ sandbox cert ⇒ 401 on production" was wrong for compliance certs.

**The bug it caused:** a guard `csidEnvMismatchMessage(token, env)` returned
`ENV_CSID_MISMATCH` whenever issuer was `eInvoicing` and `env !== "sandbox"`.
Because the compliance cert is ALWAYS `eInvoicing`-issued, this guard made it
**impossible** to submit the sample documents (`auto-compliance-check`) or run the
manual compliance-check on production — which in turn made it impossible to obtain
a Production CSID (`/production/csids` kept returning `Missing-ComplianceSteps`).
The instant ~100ms 422 the operator saw was this LOCAL guard, never ZATCA.

**Fix applied:** removed the issuer guard from the compliance-step routes
(`auto-compliance-check` and `compliance-check`) in `routes/zatca.ts`. ZATCA's own
response is the authority on whether a cert/env pairing is valid — do not pre-judge
from the issuer. The guard call still exists on the *live invoice submit* paths
(`/invoices/:id/submit`, sales `zatca-submit`) which check `PCSID ?? CSID`; a real
Production CSID may carry a real-PKI issuer there, so that path was left untouched
(revisit if a production PCSID also turns out to be `eInvoicing`-issued).

**How to apply:** when compliance samples or the manual check fail, do NOT decode
the issuer and conclude "wrong environment." Read ZATCA's actual HTTP status/body.
A real wrong-env credential surfaces as an auth rejection from ZATCA, not from a
local issuer-string heuristic. Re-onboarding on the correct gateway with a fresh
portal OTP is still the operational fix for an genuinely stale cert — but confirm
it against ZATCA's response, not the issuer CN.
