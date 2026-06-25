---
name: Reseller (Agent) network module
description: How the platform-level reseller/agent network is gated and isolated — additive design.
---

Reseller network = head office onboards distributors who manage their own client companies, renewals, commissions, support tickets, activation requests.

**Role-gated, NOT company-module-gated.** The "reseller" feature is a SuperAdmin module: nav lives in `superAdminNav` (SA-only render) + backend `requireSuperAdmin` guard on `routes/resellers-admin.ts`. There is intentionally NO `COMPANY_MODULE_GATE` key and NO frontend group-perm entry for it — adding one would be wrong. A new "reseller" role was added additively; existing company/user/permission behavior is untouched.

**Why:** task required additive-only changes. Per-tenant company gates are for tenant-facing modules; reseller admin is platform-level, so it belongs to the role gate, not the company gate.

**How to apply:** when extending reseller admin endpoints, add `requireSuperAdmin`. The reseller PORTAL (`routes/reseller.ts`) uses `requireReseller` + `resellerCompanyIds()` scoping — every portal read/write must scope to the reseller's linked companies (isolation is the core invariant). Portal action gating keys: `renew_subscriptions`, `view_reports`, `support`.
