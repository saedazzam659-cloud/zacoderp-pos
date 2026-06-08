---
name: ZATCA PCSID compliance document matrix
description: Why the Production CSID 401s until the full sample-document set is submitted, and the signing/QR convention the automated check must follow.
---

# ZATCA Production CSID (PCSID) compliance prerequisite

ZATCA only authorises a **Production CSID** after the EGS submits — and passes —
the FULL set of sample compliance documents that match the certificate's
**registered invoice type** (`companies.invoiceType`: `standard` | `simplified` |
`both`). If any required type is skipped, ZATCA never marks compliance complete
and `/production/csids` keeps returning **401**.

The required matrix is **document-type × flow**:
- flows: `standard` (clearance) and/or `simplified` (reporting) per invoiceType
- per flow: tax **invoice (388)** + **credit note (381)** + **debit note (383)**
- so `invoiceType="both"` ⇒ SIX documents.

Credit/debit notes additionally need `cac:BillingReference` (the corrected
invoice, emitted BEFORE `cac:AdditionalDocumentReference` per UBL element order)
and a `cbc:InstructionNote` reason inside `cac:PaymentMeans`.

**Why:** these are ZATCA onboarding-spec requirements, not visible from the code
or the gateway error (the 401 gives no hint about which sample type is missing).

**How to apply:** the one-click auto-compliance flow lives entirely in
`api-server` (`lib/zatca-compliance.ts` orchestrator + `POST
/companies/:id/auto-compliance-check`). Standard/clearance docs need a sample
buyer (VAT + address); simplified/reporting docs omit the buyer. Synthetic PIH
chain starts at the documented GENESIS hash, ICV 1..N, each doc's hash chains to
the next. Documents are synthetic and never persisted. Compliance endpoints exist
only on sandbox/simulation gateways — running against production 404s, so guard
`env !== "production"`.

## Signing + QR convention (mirror the offline POS register)
Generate UBL with an **empty** QR placeholder → `hashXml` the whole string
(that hash is the signature DigestValue) → XAdES-sign → build the Phase-2 QR →
**inject the QR after signing** into the empty `EmbeddedDocumentBinaryObject`.
The signer excludes the QR `AdditionalDocumentReference` from Reference#0, so
post-sign injection does NOT invalidate the signature. Submission `uuid` MUST
equal the document's `cbc:UUID`.

## Tenant-scope gap on /companies/:id/* ZATCA routes
`requirePermission` checks the permission/module gate but does NOT verify `:id`
matches the caller's company — every `/companies/:id/*` route in
`routes/zatca.ts` trusts `:id` directly (pre-existing cross-tenant IDOR).
High-impact routes (anything that submits with the company's certificate) must
add their own scope guard: for non-superadmin, require
`resolveCompanyId(req) === id`; superadmin may address any tenant (acting-company
rules). Analogous to the `companies-router-auth-gap` note.
