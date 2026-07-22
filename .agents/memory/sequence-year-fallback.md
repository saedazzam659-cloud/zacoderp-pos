---
name: Sequence fiscal-year fallback
description: 3-tier sequence resolution (exact period → same-year scoped → universal) shared by issuance, /peek and JE branch-bucket resolver.
---

# Fiscal-year fallback in sequence resolution

**Rule:** the web-ERP numbering engine resolves the sequence for a document
dated D in three tiers: (0) sequence scoped to the exact fiscal period
containing D, (1) sequence scoped to ANY fiscal period of the SAME calendar
year as D, (2) universal (empty `fiscal_period_ids`). Shared helpers
`resolveSequencePeriodMatch` / `periodMatchWhereSql` / `periodMatchRankSql`
in `lib/sequences.ts` must be used by ALL resolution sites — issuance
(`nextSequenceNumber`), the `/peek` preview, and `resolveJeIssuingBranch`
(adjustment JE branch bucket) — or preview/branch diverge from issuance.

**Why:** a backdated JE (e.g. deferred-expense run dated Dec-2025) whose date
fell in a GAP between configured fiscal periods matched no period-scoped
sequence and no universal one existed → docNumber silently NULL, and the UI
fallback showed the raw JE id, which users read as a wrong number. Same-year
fallback continues the year's own series instead.

**How to apply:** never re-implement the exact-period-only match inline;
import the three helpers. UI: when `docNumber` is null but a JE exists, show
"بدون رقم", never the JE id.
