---
name: Hooks after loading early-return crash prod (React #310)
description: Any hook placed after a conditional `if (loading) return ...` in a form component crashes with React error #310 once data resolves.
---

The rule: in zatca-invoicing document forms, EVERY hook (useRef/useEffect/useMemo/useState/useQuery) must sit ABOVE the `if (!isNew && loadingEdit) return <loading/>` early return. A hook added below it renders fewer hooks during the loading render and more after data resolves → minified React error #310 → the root ErrorBoundary "حدث خطأ غير متوقع" screen, in production, on every direct-URL open of an existing doc.

**Why:** the seed-line-prune block (`seedPrunedRef` + effect) was pasted after the early return in PurchaseInvoiceForm + PurchaseOrderForm (SalesDocumentForm had it correctly above) and crashed prod edit screens. Dev often masks it because React Query cache makes `loadingEdit` false on first render.

**How to apply:** when adding hooks to any doc form, grep for `loadingEdit) return` first and insert above it. Quick audit: for each file with that pattern, check no `use[A-Z]` hook appears after the return line.
