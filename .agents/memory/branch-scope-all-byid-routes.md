---
name: Branch-scope a doc type on ALL by-id routes, not just list
description: When making a sales/document type branch-isolated, scoping only the list endpoint leaves an IDOR on by-id reads/mutations.
---

Making a document type (e.g. sales quotations) branch-scoped like sales invoices means more than adding `branchScopeSpread(...)` to the LIST endpoint.

**Rule:** every by-id route must do a branch-scoped existence check (404 if the row is outside the user's branch scope) BEFORE acting — GET/:id, PUT/:id, PATCH/:id/status, POST/:id/convert, DELETE/:id. Also require the branch on create server-side (400), don't trust the UI. Carry the branch through any convert/derive path (quotation→invoice).

**Why:** scoping only the list lets a `viewAllBranches=false` user read/edit/convert/delete another branch's row by guessing the id (broken access control / IDOR). The frontend picker/validation is bypassable.

**How to apply:** mirror `/sales-invoices/:id` in `artifacts/api-server/src/routes/sales.ts` — it already guards the by-id read with `...branchScopeSpread(req, table.branchId, undefined)`. Add the same `and(eq(id), eq(companyId), ...branchScopeSpread(...))` lookup to each by-id handler of the new doc type.
