---
name: ZATCA compliance requestID must be server-persisted
description: Why /production/csids needs the compliance requestID persisted on the company, never the binary CSID token
---

ZATCA onboarding step 4 (`POST /production/csids`, the «استخراج شهادة الإنتاج» / PCSID button) requires the `requestID` that ZATCA returned from step 2 (`/compliance`). It is NOT the binary CSID token.

**Rule:** persist the `/compliance` `requestID` onto the company row (`companies.zatca_compliance_request_id`). `production-csid` must resolve it as `complianceRequestId (client) ?? company.zatcaComplianceRequestId (DB)` and return a clear 400 when neither exists. NEVER fall back to `company.zatcaCsidToken` — ZATCA rejects the binary token as `compliance_request_id`, surfacing as the opaque toast «فشل الاتصال بـ ZATCA».

**Why:** the original code only returned `requestID` to the browser (localStorage `zatca_compliance_reqid_${companyId}`). On the published app a new device/session/cleared storage lost it, then the wrong binary-token fallback made every PCSID attempt fail with no usable error. Persisting server-side makes the flow work for all companies regardless of browser state.

**How to apply:** legacy tenants whose CSID predates this column have NULL `zatca_compliance_request_id`; if their browser localStorage is also gone they must re-run the compliance (CSID) step once (may need a fresh portal OTP) to repopulate it, then PCSID works. The clear 400 guides them to this.

**Related open risk:** the `/companies/:id/*` ZATCA routes load/update by `req.params.id` without scoping to the authenticated tenant (potential IDOR for non-superadmin admins with `zatca_setup`). Not fixed yet — flag before touching, as a guard could interact with the SuperAdmin acting-company (`x-acting-company-id`) impersonation flow.
