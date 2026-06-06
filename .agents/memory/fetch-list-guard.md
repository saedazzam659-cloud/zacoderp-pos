---
name: fetch-list-guard
description: Frontend list queryFns must coerce to an array, or a module-gated 403 white-screens the whole page via ErrorBoundary.
---

# List query results must be array-guarded

Any React Query `queryFn` whose result is later consumed with `.find/.map/.filter`
MUST coerce the response to an array. In zatca-invoicing use the shared helper
`@/lib/fetchJsonArray` (`fetchJsonArray(url, headers)` → returns `[]` on non-ok,
non-array, or thrown).

**Why:** A module-permission-gated endpoint (e.g. `GET /api/inventory/warehouses`,
gated on the `"warehouses"` module in `inventory.ts` via `pathRbac`) returns a
**403 JSON error OBJECT**, not an array, for users/companies lacking that
permission. The old pattern `queryFn: async () => { const r = await fetch(...); return r.json(); }`
put that object straight into `data`. The common `const { data: x = [] }` default
only fires on `undefined`, so it did NOT kick in — `x` became the error object and
render-time `x.find(...)` threw `x.find is not a function`, which the global
ErrorBoundary turned into a full white-screen. This is why it reproduced in only
*some* companies (those where the role lacked the gated module) and looked
"data-driven".

**How to apply:** Route every LIST query through `fetchJsonArray`. Leave
single-object queries (edit-by-id, `/me`, settings) and mutations on raw
`r.json()` — converting those to `fetchJsonArray` would turn a needed object into
`[]` and break the form. The 7 document forms (shared `SalesDocumentForm` +
PurchaseInvoiceForm/PurchaseOrderForm/GoodsReceipts/GoodsDeliveries/SalesReturns/
PurchaseReturns) are already migrated.

**Note:** This stops the crash but a denied list shows as an empty picker with no
explanation — the real fix for "I need the warehouses to appear" is to grant the
gated module permission to that role/company, not the frontend guard.
