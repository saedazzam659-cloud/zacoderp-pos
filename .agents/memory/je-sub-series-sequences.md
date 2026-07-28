---
name: JE sub-series sequences
description: Opt-in dedicated numbering series for auto-generated JEs (depreciation, adjustments, HR, contracting, opening, stock) with fallback to the unified journal_entry series.
---

Auto-JE producers draw numbers via `nextJeSubSequence(cid, subType, ctx)`: it tries a sequence bound to the sub-type tx key first, and falls back to the unified `journal_entry` series when none is bound.

**Why:** users need per-screen sequence control on /settings/sequences (e.g. own series for قيود الإهلاك) without breaking companies that never bind one — fully opt-in, zero behavior change by default.

**How to apply:**
- New auto-JE path → add its tx key to `SEQUENCE_TX_TYPES` (lib/db schema), call `nextJeSubSequence`, add `sequences.tx.*` ar+en labels (frontend auto-lists from the API, falls back to raw key).
- Fallback never double-draws: a miss on the sub-type consumes nothing.
- Reserved-number reuse (unpost→repost) still wins before any fresh draw (`resolveJeNumber`).
- Adjustments engine: `resolveJeIssuingBranch(cid, date, subType)` must resolve the branch bucket against the SAME sequence the number will draw from (sub-type first, then journal_entry) or numbers come from the wrong branch bucket.
- Unified mode ("الطريقة العالمية"): `sequences.apply_source_prefixes` on the journal_entry-bound sequence → ALL auto-JEs draw the SHARED journal_entry counter, only the prefix comes from the sub-type-bound sequence (`prefixOverride` in NextSequenceCtx; sub-type counters NOT consumed). Peek must mirror via the JE_SUB_TYPES branch in routes/sequences.ts (`resolveForType(type, prefixOverride)`), and the monthly-reset self-heal LIKE uses the OVERRIDE prefix.

## Gate: sub-series are inert unless apply_source_prefixes is ON (2026-07-28)
Screen-bound JE sub-series must NOT affect journal numbering while the journal_entry
sequence's `apply_source_prefixes` checkbox is OFF — nextJeSubSequence, the peek
endpoint, and adjustmentPosting branch-bucket resolution all fall back to the plain
unified journal_entry series. Sub-series only ever supply the PREFIX (unified mode);
the counter always lives on journal_entry in both modes.
**Why:** tenants pre-configure screen codes now and flip them on at a fiscal-year
boundary (e.g. 2027) without disturbing live numbering; new companies can enable day one.
Mode detection is PERIOD-AWARE (unifiedJePrefixMode/activeSequencePrefix take docDate,
same exact→year→universal tiers) so a 2027-scoped JE sequence can be ON while the
current-year one stays classic. Keep issuance + peek mirrored when touching this.
