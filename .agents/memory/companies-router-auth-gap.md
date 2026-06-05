---
name: companies.ts router only blocks anonymous
description: The companies route router-level middleware does NOT enforce superadmin; per-tenant policy-write routes need their own role guard.
---

In `artifacts/api-server/src/routes/companies.ts`, the only router-level guard is
`router.use(extractAuth)` + a check that rejects requests with no `authUser` (401).
It does **NOT** enforce `role === "superadmin"`.

**Why:** Several per-tenant *policy* PATCH routes here (e.g. `/:id/menu-permissions`)
have NO inline role check and rely solely on that anonymous-only gate — meaning any
authenticated user could, in principle, rewrite another company's policy. This is a
latent broken-access-control gap, not an intentional design.

**How to apply:** Any NEW route on this router that writes cross-tenant policy
(module visibility, menu permissions, plan/feature flags, etc.) MUST add its own
explicit guard — `const u = (req as any).authUser; if (!u || u.role !== "superadmin") return 403;`
— do not assume the router middleware covers it. Mirror the pattern already used in
`/:id/profile` (superadmin OR same-company admin) or pure-superadmin (`/:id/...` admin-only).
Add API tests: superadmin allowed, tenant admin/user forbidden, cross-company forbidden.
