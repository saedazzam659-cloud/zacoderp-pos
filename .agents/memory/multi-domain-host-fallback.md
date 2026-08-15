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

## Domain binding at company creation (bindDomain)
- /api/auth/register accepts optional `bindDomain` — but it is the PUBLIC self-signup endpoint too: the binding MUST be gated on callerIsSuperAdmin or an anonymous registrant can hijack host→company routing.
- Domains-screen create schema must accept `companyId: null` (frontend sends null for main domains) — plain `.optional()` 400s "bad payload".
- After any company_domains write, call clearDomainCache() or the resolver's negative cache hides the new mapping for the TTL.
- Agent-DB-target companies (agentInstanceId) are NOT centrally bound — host→agent routing already serves them; central companyId would mismatch.

## «النطاق الموطن» (home domain restriction)
- companies.home_domain_id (nullable int, no FK — circular import) points at a MAIN company_domains row. Set at registration when SA binds a main domain (no company_domains write — main rows must stay multi-company).
- /login enforces via homeDomainBlocked(): request host (x-forwarded-host first, normalizeHost) matched against active MAIN domain rows; mismatch → generic 401 + audit. Applies to BOTH the companyCode path AND the code-less trainee path (trainee branch was a bypass until covered). Unregistered hosts (zacoderp.com/dev) unrestricted; SA path untouched. Fail-open on DB errors.

## Login isolation via home_domain_id (2026-08)
- Agent gateway domains (agent_instances.domain/extra_domains) are MULTI-company gateways: never single-company-bind them in company_domains (companyId must stay NULL) or host resolution force-routes everyone into one tenant.
- homeDomainBlocked: homed company logs in ONLY from its home domain; unhomed companies are blocked on gateway hosts (is_main rows + agent domains). Dangling home pointer fails OPEN by choice (availability; prod DB agent-read-only).
- /register bindDomain and companies PUT homeDomainId both HOME (companies.home_domain_id) on gateway domains and heal stale companyId/isPrimary binds; keep their agent-domain predicates in lockstep and CASE-INSENSITIVE incl. extra_domains (jsonb_array_elements_text + lower, not @> containment).
- companies PUT homing is SA-only, gateway-domains-only (is_main or agent), sent OUTSIDE UpdateCompanyBody; UI lives in SA CompanyDetails «النطاق الموطن».

## Agent external-DB routing vs company creation (2026-08)
- An agent with db_status=initialized + db_url_enc serves its OWN PostgreSQL for every request on its domain (agentDataSourceRouter/runWithExternalDb). A company created centrally can NEVER log in from that domain — homing is irrelevant there. Companies for such agents must be created via /register with agentInstanceId (SA wizard «وجهة إنشاء الشركة»).
- /register bindDomain now warns (and skips homing) when the bound domain belongs to an initialized-DB agent without agentInstanceId; CompanyNew auto-selects the agent target when its domain is picked.
- homeDomainBlocked must resolve the host via resolveAgentRequestHost (token-verified X-Zacod-Agent-Host) — agent proxies rewrite Host/X-Forwarded-Host to the central domain.
- SA management of agent-DB companies: GET /api/companies merges agent rows (tagged agentInstanceId/agentName) for SA; per-company admin ops carry ?agent=<id> through runWithAgentScope (lib/agentScope.ts). It must accept BOTH req.adminUser (requireSuperAdmin) and req.authUser (extractAuth) — admin.ts never sets authUser. ZATCA onboarding endpoints are NOT agent-scoped: hide the ZATCA tab/shortcut for agent companies or a colliding central ID gets touched.
- Agent subscriptions/modules: /admin/subscriptions GET merges agent rows; PUT/extend/change-plan + companies menu-permissions PATCH take ?agent= via runWithAgentScope; change-plan plan_configs MUST read centralDb; menu-permissions PATCH needs its own superadmin gate (companies router only blocks anonymous); frontend keys rows by `${agent??'c'}:${id}` (ids collide cross-DB); bulk subscription ops stay central-only; reseller/partner commission accruals inside agent scope hit the agent DB → effectively no-op for agent companies.
