---
name: Developer Cloud (Workspaces) module
description: Phase-5 SA-only partner dev-cloud — security boundary + publish-only deploy invariants
---

A Replit-like cloud for partner teams: one isolated workspace per company
(sandbox + git + storage + test env), multi-role developer seats, deployments.
Modelled on the partners/reseller/extension SA-only platform pattern.

**Hard security boundary (the whole point of the task):** the platform NEVER
stores or returns server credentials, SSH, RDP, or direct DB access. Only opaque
provider *references* (external workspace/sandbox IDs, git/storage/test URLs) are
kept. A workspace is `active` only when all four resources are recorded.
**Why:** the task's core requirement is "deployment ONLY via Publish engine —
never expose infra credentials." Any future field that smells like a credential
or connection string violates the contract.

**Publish-engine-only deploy:** `dev_deployments.method` is hard-fixed to
`'publish_engine'`; there is intentionally NO other deploy path. A deployment
requires the workspace to be `active` AND, if a seat is named, that seat must be
active and hold the `trigger_publish` permission. Least-privilege is enforced
server-side, not just in the UI.

**Least-privilege seats:** roles (pm/backend/frontend/mobile/qa/devops) map to
default permission sets; creating/role-changing a seat without an explicit
permission map re-applies the role defaults. PM/QA never get code/publish by
default.

**How to apply:** all logic lives in `lib/db/src/schema/devCloud.ts` (constants
+ tables), `artifacts/api-server/src/routes/dev-cloud-admin.ts` (router, mounted
at `/api/admin/dev-cloud` before zatcaRouter), and
`artifacts/zatca-invoicing/src/pages/DevCloudAdmin.tsx`. SA-only screen → no
company module gate (like إدارة النطاقات). Adding a doc/seat capability means
extending `DEV_SEAT_PERMISSION_KEYS` + `DEV_ROLE_DEFAULT_PERMISSIONS` together.
