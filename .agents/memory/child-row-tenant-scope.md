---
name: Child-row tenant + branch scope (no own branch_id)
description: How to isolate child tables that inherit scope from a parent (controls→RA, CAPA actions→incident)
---

Child tables that have NO own `branch_id` (e.g. safety risk *controls* under a
risk assessment, safety *CAPA actions* under an incident) inherit both
multi-tenant and per-branch scope from their PARENT row. Every code path that
reads, aggregates, or mutates them must resolve the parent first.

**Rule:**
- PATCH/DELETE on a child by id: fetch the child, then assert the parent's
  branch scope (`assertRaScope` / `assertIncidentScope` join to parent +
  `rowInScope`). A bare `companyId=cid` filter does NOT stop a branch-restricted
  user mutating a sibling-branch child.
- Child READS (`GET parent/:id` expanding children): still add an explicit
  `companyId=cid` on the child query — joining only on parent_id leaks rows if
  data integrity is ever violated.
- KPI/aggregate over children: inner-join to the parent and put BOTH the
  branch condition AND `parent.companyId=cid` in the join, not just the child's
  own companyId.

**Why:** branch-scope enforcement that only checks the child's companyId (or
only the parent's existence) silently leaks across branches/tenants; the child
row carries no branch_id of its own so the parent is the only source of truth.

**How to apply:** any new parent→child module (lives in
`artifacts/api-server/src/routes/safety.ts` as the reference pattern). Reuse the
`branchScopeFilter` / `rowInScope` helpers from `middleware/auth.ts`.
