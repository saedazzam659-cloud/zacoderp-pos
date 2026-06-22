---
name: POS Desktop ActionBar single-row selection scope
description: How the top-bar document action pattern (useRowSelect) must bind to the VISIBLE rows, not the full set
---

Document list screens expose their per-row verbs (عرض/طباعة/إرجاع/ترحيل/فك الترحيل/
تعديل/حذف/convert) from ONE top `ActionBar` driven by a single-row radio
(`useRowSelect` + `SelectTh`/`SelectCell` in `_adminUi.tsx`), instead of a per-row
action cell.

**Rule:** bind `useRowSelect(...)` to the **VISIBLE/filtered** dataset, never the raw
`rows`. `useRowSelect` self-clears the selection ONLY against the array you pass it.

**Why:** if you pass the full `rows`, a row that is filtered/searched out of view stays
selected, and the top ActionBar will happily run post/delete/unpost on a document the
user can no longer see — a silent footgun (architect-flagged regression).

**How to apply:**
- Grid screens (`useGridFilter`) → `useRowSelect(grid.view)`.
- Screens with a custom `filtered` memo (e.g. JournalEntries) → `useRowSelect(filtered)`,
  and declare the hook AFTER the `filtered` memo (TDZ — it's a `const`, not hoisted).
- Plain screens that only paginate a `pageSlice(rows, …)` with NO row-hiding filter can
  pass `rows` (paging hides rows but the selected row is still a real current doc).
- StockAdjustments/StockTransfers list rows are data-only (no per-row verbs) → no ActionBar
  needed; only the create form has buttons. Don't add an empty bar.
