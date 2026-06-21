---
name: Merged-report sources each need their own branch scope
description: A report that merges two party types (e.g. sister companies into customer balances) must branch-scope EACH source endpoint, not just the primary one.
---

The Customer Balances report (أرصدة العملاء) merges sister-company AR balances in as if they were customers. The customer side (`/api/customers/balances`) was branch-scoped, but the sister side (`/api/sister-companies/balances`) ignored `branchId`, so a sister linked to branch 1 still appeared when filtering branch 2.

**Rule:** every aggregate/balance endpoint feeding a merged report must apply its own branch scope. For a per-party row, scope by that party's master `branch_id` (`branchScopeSpread(req, sisterCompaniesTable.branchId, bid)`), and the frontend must pass `branchId` into BOTH source queries' params and query keys. NULL-branch parties stay shared/visible from any branch.

**Why:** branch filtering only on the primary source silently leaks the secondary source's rows into the wrong branch — the user sees a sister-company balance under a branch it isn't linked to.

**How to apply:** mirror `/api/customers/balances` (filters visibleRows + each movement by branch). Note a remaining parity nuance: sister balances scope by the sister's MASTER branch, not by each transfer/return/settlement's own branch — totals can differ if a transfer's branch diverges from the sister's branch. Acceptable for the per-sister-company report; revisit only if movement-level isolation is required.
