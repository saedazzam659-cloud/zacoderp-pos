---
name: Historical JE migration (backdated import)
description: Rules for migrating multi-year backdated journal entries through an isolated import path.
---

# Historical/backdated journal-entry migration

Lives as an ISOLATED path in `data-io.ts` (`/import/historical/{scan,ensure-years,commit}`), separate from `commitComposite`/the generic upsert importer.

- **Group by `${entryDate}::${docNumber}`, ALWAYS-INSERT.** Entry numbers repeat across years, so upserting by docNumber alone silently overwrites e.g. 2021's #1 with 2022's #1.
- **Never post a JE with a null `period_id`.** Resolve the fiscal period from the entry date and HARD-ERROR (skip/error the group) when none matches — a posted entry with null period is stranded outside every period-scoped report and the closing cycle.
  **Why:** `ensureAnnualFiscalYears` marks a year "existing" on any *overlap* (not full coverage), so a date can fall in a gap.
- **Fiscal-year auto-creation must be atomic + serialized per company.** Wrap the year row + its annual period (Jan1–Dec31) insert in ONE transaction guarded by `pg_advisory_xact_lock(<ns>, companyId)`. Otherwise a partial failure leaves a year without its period, and concurrent commits both pass the read-then-insert overlap check and double-create the year.
- Reuse existing system helpers — `ensureLeafAccounts`, `LOCKED_JE_TYPES` (coerce entryType to a non-locked default), 0.01 balance tolerance, and the `/import/process` FK-resolution step — never re-implement them.
- Year-end closing reuses the existing `/api/fiscal/periods/:id/{close-pl,transfer-profit,soft-close,hard-close}` endpoints unchanged (same as `PeriodClosingWizard.tsx`).
