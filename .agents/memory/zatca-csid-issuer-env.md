---
name: ZATCA CSID issuer reveals environment
description: How to tell which ZATCA gateway issued a stored CSID, and why a cross-env CSID 401s on the live gateway.
---

# ZATCA CSID issuer reveals which environment minted it

The stored compliance/production CSID (`zatca_csid_token` / `zatca_pcsid_token`) is a
certificate whose **issuer CN tells you the environment that issued it**:

- **`CN=eInvoicing`** (bare, no O/C) = ZATCA **developer-portal / Sandbox** CA.
- Simulation and Production issue from the real ZATCA PKI — the issuer is a proper
  CA name, **never** the bare `eInvoicing`.

**Why it matters:** a CSID is bound to the gateway that minted it. Presenting a
sandbox-issued CSID to `simulation`/`core` (production) → **HTTP 401 with an empty
`{}` body** on `/compliance/invoices` (all samples fail) and a generic failure on
live invoice submit. The data in the invoice is irrelevant; 401+empty body == auth
rejection == wrong-environment credential, not a BR-KSA validation error.

**Common real-world cause:** company onboarded in Sandbox to test, then flipped
linking mode to Production WITHOUT re-running the CSID issuance against the
production Fatoora portal. The stale sandbox CSID lingers and is rejected.

**Operational fix (cannot be done in code — credentials come from ZATCA):**
regenerate CSR → fresh production OTP from `fatoora.zatca.gov.sa` → استخراج CSID →
الفحص التجريبي → شهادة الإنتاج (PCSID). A regenerated CSR also rotates the private
key, so the new CSID matches the current key pair.

**Code safeguard:** `csidEnvMismatchMessage(token, env)` in `lib/zatca-env.ts`
decodes the base64-over-base64 DER (ASN.1 `0x30` gate, defensive double-decode),
reads the issuer CN, and returns an actionable Arabic message (code
`ENV_CSID_MISMATCH`) when issuer is `eInvoicing` but `env !== "sandbox"`. Wired
into auto-compliance-check, `/invoices/:id/submit`, and sales `zatca-submit` so the
opaque 401/500 is replaced by a clear "re-onboard on production" message.

**How to apply:** when a tenant reports "all compliance samples fail" or "فشل
الاتصال بـ ZATCA" on live submit, FIRST decode the stored CSID issuer before
suspecting invoice/signing bugs. `eInvoicing` issuer + non-sandbox env == the
diagnosis.
