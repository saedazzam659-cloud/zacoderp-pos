---
name: ZATCA compliance-check gateway 404 vs validation failure
description: How to tell a ZATCA onboarding "الفحص التجريبي" gateway rejection apart from an invoice-validation failure, and why the env must match the CSID.
---

# ZATCA compliance-check (الفحص التجريبي) — gateway 404/401/403 ≠ invoice-validation failure

When `POST /api/companies/:id/compliance-check` forwards a **404/401/403** from ZATCA, that is a
**gateway-level rejection** — ZATCA never validated the invoice, so the response has **no**
`validationResults.errorMessages`. Do NOT read it as "the test invoice is bad." The invoice data
can be perfectly valid (issued, valid signed XML, correct company, CSID present) and still get a 404.

**Most likely cause:** environment / CSID mismatch. The base URL is chosen purely from
`company.isSandbox` (`true` → `.../developer-portal`, `false` → `.../core` production). The compliance
test MUST run on the **same** ZATCA environment where the CSR+CSID were obtained. A CSID issued on the
sandbox/developer-portal but checked against `core` (or vice-versa) yields a gateway 404, not a
validation error.

**Why this was hard to see:** the sibling `/compliance` route logs ZATCA failures via `req.log.warn`,
but `compliance-check` originally did neither — it forwarded the status with only a generic Arabic
hint, and the UI (`ZatcaIntegration.tsx`) rendered ONLY `validationResults.errorMessages`. A gateway
404 has none, so the user saw "فشل الفحص" with zero actionable detail and the server logged nothing.

**How to apply:** on any opaque external-API forward-failure, (1) log status + endpoint + raw response
server-side, and (2) surface the raw response + status + which environment was hit in the UI when
structured error messages are absent. The compliance/clearance endpoint **paths**
(`/compliance/invoices/clearance/single` for standard, `/compliance/invoices/reporting/single` for
simplified) are CORRECT and verified against the pos-desktop standalone gateway — do not "fix" the path
when chasing a 404; check the environment/CSID pairing first.
