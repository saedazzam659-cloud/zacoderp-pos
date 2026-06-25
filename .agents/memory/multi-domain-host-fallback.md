---
name: Multi-domain host resolution
description: How per-company custom domains resolve to a company, and why it's a pure fallback / SA-only with no company module gate.
---

# Multi-domain host resolution

A company can run on its own domain while staying on the shared multi-tenant DB.
`company_domains` (one domain → one company, `status` pending/active/disabled,
`isPrimary`) maps a host to a company. `resolveDomainCompany` middleware sets
`req.domainCompanyId` ONLY for an `active` mapped host (60s TTL cache,
best-effort, never throws/blocks).

**Rule — strict fallback ordering in `resolveCompanyId` (superadmin only):**
explicit `?companyId=` → `x-acting-company-id` acting-company → `domainCompanyId`
→ `undefined` (multi-company view). Domain is the LOWEST priority and must never
override explicit targeting or impersonation. Tenant users are always scoped to
their own `companyId` regardless of host.

**Why:** the main/unmapped domain must keep the existing multi-company behavior,
and SuperAdmin tooling (`/admin/*`, acting-company banner) must keep working when
browsed on any host. A mapped host is a convenience, not an authority.

**Module gating is N/A for SuperAdmin-only platform screens.** `COMPANY_MODULE_GATE`
(+ `lib/menuItems.ts` / `MenuPermissions`) only gate *tenant-facing* modules via a
per-user permKey. The "إدارة النطاقات" screen lives in `superAdminNav` (always shown
to SA, no permKey, no tenant API), so registering a gate key would be dead, misleading
noise — deliberately skipped (Task #236 step 6). Apply this to any future SA-only
platform-control screen: do NOT invent a company module key for it.

**How to apply:** when adding a new host-aware feature, read host via
`x-forwarded-host`/`host` through `normalizeHost`, and keep any host→tenant mapping
as a fallback after explicit + impersonation context. Operational note: trust of
`x-forwarded-host` assumes the shared edge proxy sets it.
