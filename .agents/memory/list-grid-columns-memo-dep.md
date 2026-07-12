---
name: List-grid COLUMNS memo dependency trap
description: Column-descriptor arrays used as useMemo deps must themselves be memoized or huge lists refilter/resort every render.
---

**Rule:** In the big list/audit grids, the column-descriptor array (`COLUMNS` with `valueOf` closures) feeds the `filtered` useMemo. If COLUMNS is recreated per render, every render (hover, selection, dialog) re-filters + re-sorts the whole dataset — on data-heavy companies this reads as a page hang. Memoize COLUMNS on `[t]`, defer the search text (`useDeferredValue`), and memoize whole-list reduces (grand totals).

**Why:** /accounting/journals froze for a heavy tenant purely from this render-loop refiltering, even after the backend was fast.

**How to apply:** Any grid whose filter/sort useMemo lists a locally-built descriptor array or label map in its deps — memoize those inputs first before blaming the backend. Backend twin: list endpoints need (company_id, created_at) + child (parent_id) indexes, sums via subquery not giant IN id lists, and should strip fat unused columns (IP/UA) from list payloads.
