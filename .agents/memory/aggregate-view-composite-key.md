---
name: Aggregate list-view selection must use composite keys
description: Multi-table "show all" grids must key row selection/bulk actions by module:id, never numeric id alone.
---

# Aggregate list-view selection keys

When a grid aggregates rows from **multiple source tables** into one list (e.g. the
Posting Center "عرض الكل" mode merging sales invoices + journal entries + vouchers +
stock docs), numeric `id` is NOT unique across the merged set — a sales invoice #5 and
a journal entry #5 collide.

**Rule:** selection state, per-row busy state, bulk-action lookup maps, and DOM
`data-testid`s must all key on a composite `\`${module}:${id}\`` (define one shared
`rowKey(r)` helper), never on `id` alone.

**Why:** keying selection by `id` + resolving the action endpoint via
`rows.find(r => r.id === id)` returns the FIRST same-id row — so a click can post/unpost
the WRONG document in a different module. Silent, data-corrupting, and invisible in
single-module mode (ids are unique within one table), so it only surfaces once an
aggregate/"all" view is added.

**How to apply:** the moment a list view starts merging >1 table, audit every
`selected.has(...)`, `toggleRow(...)`, busy-id compare, and bulk `find`/map for raw `id`
usage and switch them to the composite key. Build a `new Map(rows.map(r => [rowKey(r), r]))`
for bulk execution instead of `find`.
