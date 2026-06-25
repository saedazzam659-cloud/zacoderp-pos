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

**The "إدارة النطاقات" screen is SuperAdmin-ONLY and has NO company module gate.**
It lives in `superAdminNav`, the route is `isSuperAdmin`-gated, and `routes/domains.ts`
has a `router.use` superadmin-only 403 guard — that is the whole access model. A
default-OFF `multi_domain` company-module gate WAS once added (key in
`COMPANY_MODULE_GATE` + a `MODULE_GATE_DEFAULT_OFF` set + a `menuItems.ts` toggle + a
`Layout.tsx` `superadminModuleGate` field), then **explicitly removed at the owner's
request**. **Why:** a SuperAdmin-only platform feature is NOT per-tenant, so exposing it
as a toggle inside companies' menu permissions was confusing noise — and making even the
SuperAdmin enable it on their own company before it appears is a footgun. **How to apply:
do NOT re-introduce a company module key for any SuperAdmin-only platform screen** —
gate it with `isSuperAdmin` (nav + route) + a superadmin `router.use` on the API.
(`MODULE_GATE_DEFAULT_OFF`/`DEFAULT_OFF_KEYS` are now empty sets — inert generic infra,
not a live feature.)

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
