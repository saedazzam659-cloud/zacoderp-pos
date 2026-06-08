---
name: ZATCA compliance-invoice endpoint is single, not split
description: The compliance check posts every sample doc to ONE /compliance/invoices path; the .../clearance/single and .../reporting/single split is LIVE-invoice only and 404s during onboarding.
---

# ZATCA compliance check uses ONE endpoint: `/compliance/invoices`

During onboarding, ALL compliance sample documents (standard + simplified,
invoice + credit + debit) are POSTed to a **single** path:

```
{baseUrl}/compliance/invoices
```

ZATCA auto-detects clearance vs reporting from the `InvoiceTypeCode` inside the
XML. The split paths used by LIVE invoices —
`{baseUrl}/invoices/clearance/single` (B2B) and
`{baseUrl}/invoices/reporting/single` (B2C) — do **NOT** exist under
`/compliance/...`. Posting compliance samples to
`/compliance/invoices/clearance/single` or `.../reporting/single` returns
**404**, so the compliance check silently never completes and the later
`/production/csids` call 401s ("You are not authorized to use this api endpoint").

**Verified empirically (all envs):**
- `POST .../core/compliance/invoices` → 400 (exists, bad body)
- `POST .../core/compliance/invoices/clearance/single` → 404 (does NOT exist)
- `POST .../core/invoices/clearance/single` → 400 (live endpoint, exists)

**Why this was a 2-day bug:** a prior memory note asserted the
`.../clearance/single` / `.../reporting/single` compliance paths were "CORRECT
and verified — do not fix the path when chasing a 404." That was WRONG and sent
debugging down the env/CSID-mismatch path instead. When a ZATCA
`/compliance/...` call 404s, **check the path first**, then the env/CSID pairing.

**How to apply:** both the manual compliance-check route (`routes/zatca.ts`) and
the auto-compliance orchestrator (`lib/zatca-compliance.ts`) build
`endpoint = ${baseUrl}/compliance/invoices`. Body is `{invoiceHash, uuid,
invoice(base64)}`, headers `Accept-Version: V2` + Basic auth (compliance
CSID:secret). Keep both sites in lockstep.
