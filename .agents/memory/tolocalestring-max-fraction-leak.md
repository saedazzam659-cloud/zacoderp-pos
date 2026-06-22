---
name: toLocaleString missing maximumFractionDigits leaks a 3rd decimal
description: Why money totals showed 3 decimals while per-line/saved values showed 2 in zatca-invoicing
---

`Number(x).toLocaleString(locale, { minimumFractionDigits: 2 })` with NO
`maximumFractionDigits` does NOT cap at 2 — `Intl.NumberFormat` defaults max to
`max(min, 3)`, so any value carrying residue (e.g. VAT = Σ unrounded per-line
floats) renders with a 3rd decimal (2,269.526 / 17,399.696) while per-line
`finalCost` and the SAVED totals use `.toFixed(2)` (17,399.70). Result: on-screen
totals visibly disagree with the line figures and the persisted amounts.

**Why:** ~14 document/print forms each defined an ad-hoc `fmt`/`fmtSAR` instead of
the canonical `useFmt()` hook (`hooks/use-fmt.ts`, which sets min==max==company
`decimalPlaces`). The ad-hoc ones omitted the max → display-only leak. Saved/compute
logic was already correct (hardcoded `.toFixed(2)`), so this was purely a formatter
defect, not a calculation bug.

**How to apply:** For money display in zatca-invoicing prefer `useFmt().fmtVal/fmt`.
If you must hand-roll `toLocaleString` for currency, ALWAYS pass BOTH
`minimumFractionDigits` AND `maximumFractionDigits`. To audit:
`rg "\{ minimumFractionDigits: 2 \}"` — any same-line hit (closing brace, no max) is
the bug. Note these forms intentionally align to a hardcoded 2-decimal business rule,
not company `decimalPlaces`; honoring `decimalPlaces` globally would be a separate
controlled migration touching compute+save+display in lockstep.
