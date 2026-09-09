---
name: SuperAdmin acting-company isolation
description: Tenant-bound UI and API rules when a SuperAdmin enters a company.
---

When a SuperAdmin is acting inside a company, every tenant-bound direct fetch must send the acting-company header and include that company ID in its cache key. Tenant APIs must reject a missing company scope instead of treating it as permission to query all companies.

**Why:** A company-scoped screen once omitted the acting company and reused an undefined cache key, while its list endpoint used an unfiltered fallback. Entering a new company then displayed account rows from unrelated tenants even though provisioning had not copied their data.

**How to apply:** For tenant screens, derive the effective company as `actingCompanyId` for SuperAdmin and the authenticated company otherwise; disable queries until it exists. Scope reads, writes, relationship IDs, and imports on the server, and fail closed if resolution returns no company.