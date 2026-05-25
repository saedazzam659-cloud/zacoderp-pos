---
name: Module gate keys live in two places
description: A new module key must be registered in both the backend company-gate map AND the frontend sidebar group-perms array, or it silently breaks.
---

When adding a new gated module (anything that should appear under Sales/Purchasing/Cash/... sidebar groups and be toggleable per company):

1. **Backend** — add the key to `COMPANY_MODULE_GATE` in `artifacts/api-server/src/middleware/permissions.ts`, mapping it to the parent billable module (e.g. `customer_notes: "sales_module"`). Without this, the per-company "disable sales_module" toggle does NOT 403 calls to the new module's routes.
2. **Frontend** — add the key to the matching `*_GROUP_PERMS` array in `artifacts/zatca-invoicing/src/components/Layout.tsx` (e.g. `SALES_GROUP_PERMS`, `PURCHASING_GROUP_PERMS`). Without this, a role that has ONLY the new permission sees the parent sidebar group hidden by `groupVisible(user, …_GROUP_PERMS)` and cannot navigate to the page at all — even though the route exists in `App.tsx`.

**Why:** the two maps are independent — backend gates control HTTP access, frontend gates control whether the sidebar parent group renders. Forgetting either side produces a confusing "the page works but I can't reach it" or "the toggle does nothing" bug.

**How to apply:** every time you wire a new `permKey` into the menu, grep for the parent module's existing keys in both files and add yours alongside them. The catalog file `lib/.../menuPermissionCatalog.ts` only registers the key for RBAC — it does NOT replace either of the two maps above.
