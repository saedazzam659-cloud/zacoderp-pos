---
name: branchScopeSpread on a missing column
description: Why branch-scoping a table whose schema lacks branch_id crashes ONLY restricted users (500), never admins.
---

`branchScopeSpread(req, table.branchId, req.query.branchId)` reads `table.branchId`
off the Drizzle table object. If the table's schema never declared a `branch_id`
column, `table.branchId` is `undefined`.

**The trap:** for admin / view_all_branches users the helper builds NO branch
condition, so the missing column is never referenced and everything works. For
restricted (view_all_branches=false) users it builds a WHERE on the undefined
column → invalid SQL → **500 only for restricted users**. The list endpoint then
returns a non-array error body and any frontend `.filter`/`.map` over it throws
"_.filter is not a function", white-screening the page.

**Why this is easy to miss:** a route can be fully branch-scoped (and even require
`branchId` on create) while the schema column was never added — or was *dropped*
by a merge that reconciled away the column. The code reads as correct; only the
schema is wrong.

**How to apply:** before adding `branchScopeSpread` (or when one mysteriously 500s
for non-admins only), confirm the table actually has `branchId: integer("branch_id")`
in its schema AND the column exists in the DB. As defense-in-depth, route list
queryFns through `fetchJsonArray` so a non-array response renders empty instead of
crashing the page.
