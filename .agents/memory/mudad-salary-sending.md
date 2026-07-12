---
name: Mudad salary sending (منصة مدد)
description: Saudi Mudad WPS salary-export feature — no public API, tenant-isolation gotcha, kafala eligibility model.
---

# Saudi منصة مدد (Mudad) salary sending

Additive HR feature: evaluate a payroll run against Mudad eligibility rules, snapshot included/excluded employees into a batch, and export a WPS-compatible file.

## Durable decisions

- **Mudad has NO public API.** Do not attempt an API integration. The chosen approach ("Option 1 — SIMPLE") generates a WPS-compatible CSV export FILE (UTF-8 BOM, built client-side) that the employer uploads to the Mudad portal manually. The backend contract (persisted batch + evaluated lines) is designed so a live Mudad API could be wired later WITHOUT changing it.

- **`payroll_lines` has NO `company_id` column.** Tenant isolation for anything joining payroll lines to employees must be enforced via (a) validating the parent `payroll_runs` row belongs to the company first, AND (b) an INNER JOIN requiring `employees.company_id = cid`. Never assume a `payroll_lines.companyId` predicate — it will not typecheck and there is no such column. An orphaned/cross-tenant line is dropped by the inner join rather than leaking bank details.

- **Kafala eligibility model** lives as additive columns on `employees` (saudiType, employmentType regular/irregular, onSponsorship, borderNumber, establishmentNumber, sponsorship dates, workPermitExpiry, bankApproved). These are auto-added to the DB by `ensureColumns` (reads the drizzle schema) — no manual ALTER needed. The two batch tables (`mudad_salary_batches`/`mudad_salary_batch_lines`) DO need explicit CREATE TABLE in ensureSchema because ensureColumns only ALTERs existing tables.

- **Exclusion engine** default mode is `sponsored_only` (send only sponsored/kafala employees). First failing rule wins, ordered: resigned → suspended → inactive → [sponsored_only only: not_sponsored, irregular] → non-Saudi (iqama_expired / work_permit_expired) → no_id → no_iban → bank_not_approved. Mode `all` skips the sponsorship/irregular gates.

**Why:** built for a Saudi ZATCA ERP where Mudad compliance is required but no automated channel exists; the batch snapshot gives an auditable excluded-employees report.

## Security (learned via code review)

- Every Mudad endpoint MUST carry server-side `requirePermission("hr_payroll", "view"|"create")` — frontend `PermRoute` is cosmetic. Reads = view, batch creation = create.
- Batch-detail line queries must filter `mudad_salary_batch_lines.company_id = cid` (defense-in-depth) even after validating the parent batch belongs to the company.
