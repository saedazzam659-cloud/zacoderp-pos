---
name: Company template defaults on tenant creation
description: New companies are seeded from a template company (default id 10) — settings, sequences, COA clone with party-account exclusion
---

- `applyCompanyTemplateDefaults(companyId)` in api-server `lib/companyTemplate.ts` runs on BOTH creation paths (superadmin `POST /companies` and public `POST /auth/register`). Template id = `TEMPLATE_COMPANY_ID` env, default 10.
- Clones: (1) companies display/print columns (menuLayout, invoiceFormLayout, print_*), (2) sequence DEFINITIONS — dedup per transactionTypes set keeping newest updatedAt, counter reset to startNumber, branchIds/fiscalPeriodIds emptied (template-local ids), journal_entry sequence FORCED monthlyReset+applySourcePrefixes with `{MM}` pattern fallback, (3) COA tree level-ascending with parent remap.
- **Party-account exclusion (security):** referenced accounts (customers/suppliers/employees.payable/salesReps/sisterCompanies/cashBoxes/bankAccounts) + party-CONTAINER rule (every posting-leaf sibling of a referenced child is excluded — catches orphaned party accounts) + name pattern `جاري الشريك`. Reference lookups alone are NOT enough — orphan party names would leak cross-tenant.
- **Fallback invariant:** if the company still has zero accounts after cloning (template missing/empty/clone failed), `seedDefaultChartOfAccounts` runs — no tenant may start without a COA. Every part is best-effort and never blocks creation.

**How to apply:** new entity tables that mint per-party accounts must be added to the exclusion set; changes to sequence semantics must keep clones universal (no period/branch scoping).
