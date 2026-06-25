---
name: Multi-domain host resolution
description: How per-company custom domains resolve to a company (pure SA-only fallback), the default-OFF multi_domain module gate, and the main (company-less) domain.
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

**Multi-Domain is a LOCKED / default-OFF platform module (`multi_domain`).** Unlike
normal tenant modules (absent key ⇒ allowed), default-OFF modules are gated by a
`MODULE_GATE_DEFAULT_OFF` set so an ABSENT key ⇒ DENIED. This set + the `multi_domain`
entry must be mirrored in FOUR places or the gate goes inconsistent: backend
`permissions.ts` (`companyAllowsModule`), frontend `companyModuleGate.ts`,
`MenuPermissions.tsx` (`DEFAULT_OFF_KEYS`, so the toggle renders OFF), and
`menuItems.ts` (the toggle entry). The gate applies EVEN to SuperAdmin: in
`Layout.tsx` `navItemAllowed`, a NavDef `superadminModuleGate` is checked BEFORE the
`role==="superadmin"` auto-allow; `App.tsx` wraps the route in `companyAllowsModule`;
`routes/domains.ts` adds a second `router.use` 403 gate after the SA role guard.
**Why:** the screen lives in `superAdminNav`, but the requirement is that it stay
hidden/403 until explicitly enabled on the OPERATOR'S OWN company
(`companies.menuPermissions`) — so the SA enables `multi_domain` on their own company
via the MenuPermissions screen to reveal it. **How to apply:** to add another
default-locked SA platform module, add its key to ALL FOUR `MODULE_GATE_DEFAULT_OFF`/
map spots and set `superadminModuleGate` on its NavDef + a route + API gate.

**Main (company-less) domain — `is_main` + nullable `company_id`.** A domain row may
be `isMain=true` with `companyId=NULL`: the shared multi-company domain that keeps the
default multi-company behavior. `isMain` and a bound company are mutually exclusive
(API normalizes: main ⇒ companyId null + isPrimary false); `demoteOtherMains()` keeps
at most one main (API-enforced, no DB unique). `resolveDomainCompany` needs NO change —
a null `companyId` naturally yields no `req.domainCompanyId`, i.e. no scoping.

**How to apply:** when adding a new host-aware feature, read host via
`x-forwarded-host`/`host` through `normalizeHost`, and keep any host→tenant mapping
as a fallback after explicit + impersonation context. Operational note: trust of
`x-forwarded-host` assumes the shared edge proxy sets it.
