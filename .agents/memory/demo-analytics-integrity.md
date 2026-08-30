---
name: Demo analytics integrity
description: Central demo telemetry must remain privacy-safe and concurrency-safe across direct and agent sources.
---

Demo analytics is control-plane data and must not trust client-provided dimensions or agent host matching as identity. Server-owned finite event categories and route templates are required; session duration deltas and agent receipts must be serialized/idempotent.

**Why:** The analytics database is shared across demo tenants and agents, so a permissive client field or check-then-insert race can both leak identifiers and corrupt sales signals.

**How to apply:** Keep agent ingestion bound to a verified proxy credential, derive route/module/screen/action values from finite server taxonomy, and update session/profile duration under one row-locked transaction with terminal end replay. A source-company manager's read scope includes only that company plus hidden demo workspaces whose trusted `demoParentCompanyId` points to it; source kind and agent instance must still match on dashboard, list, filters, and detail.