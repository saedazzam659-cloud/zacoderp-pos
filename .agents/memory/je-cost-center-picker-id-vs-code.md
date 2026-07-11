---
name: JE cost-center picker id-vs-code rehydration
description: Why a JE line's cost centre shows in print/tooltip but blank in the entry-form combobox, and how to normalize.
---

# JE cost-center picker: id vs code

The journal-entry form (`artifacts/zatca-invoicing/src/pages/accounting/JournalEntryForm.tsx`)
builds its cost-centre combobox options keyed on the cost centre **CODE**
(`costCenterOptions` value = `c.code`). But SYSTEM-generated JEs — fixed-assets
depreciation (`fa-journals.ts`), production, contracting — store the numeric
cost-centre **ID** (stringified) on the line, while MANUAL JEs store the code.

**Symptom:** on such a JE the cost centre shows correctly in the print template
and the hover tooltip (both use `findCc`, which indexes by BOTH id and code) but
the combobox shows the empty placeholder in view/edit mode, because the stored
id never matches a code-keyed option.

**Fix:** normalize at render — pass `ccCode(line.costCenter)` (resolves id→code
via `findCc`, falls through unchanged when unresolved) as the combobox `value`,
NOT the raw `line.costCenter`. Render-time normalization is robust to the
cost-centres query resolving AFTER `existing` loads; do it there, not in the
`existing` load effect. If the user never edits the line, the raw id is still
what gets saved (backend accepts it) — no save-behavior change.

**Why:** picker options and system-JE line storage use two different keys for
the same dimension. Any dimension picker (cost centre, branch, project) fed by
options keyed on one field while some producers store another field will silently
show blank on rehydration.

**Related:** cost-centre options also filter `isActive !== false`, so a centre
that later goes inactive won't appear even after id→code normalization (separate
edge case, not fixed here).
