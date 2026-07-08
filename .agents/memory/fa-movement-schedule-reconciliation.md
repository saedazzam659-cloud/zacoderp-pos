---
name: FA movement-schedule GL reconciliation
description: How the fixed-assets depreciation movement schedule reconciles registry vs GL, and the shared-accum-account trap.
---

# Fixed-assets movement schedule (جدول الإهلاك) reconciliation

`GET /api/fixed-assets/reports/movement-schedule` (fixed-assets.ts) builds a
GL-based depreciation/movement schedule grouped by the main asset **cost** COA
account. Each group = registry-primary asset rows + ONE "unlinked" reconciliation
row (GL movement not explained by registered assets — captures purchase-invoice /
manual-JE assets).

**Rule: an accumulated-depreciation account can be SHARED by many cost accounts.**
The common Saudi COA has all assets crediting ONE مجمع الإهلاك account. So accum→cost
is one-to-many, never 1:1.

**Why this matters (the bug that was fixed):** computing the unlinked depreciation
residual *per cost group* by pulling the shared accum account's GL and then
subtracting only that group's registered dep double-counts. The shared accum GL
already contains every group's depreciation, so a first-write-wins `Map<accum,cost>`
dumps all of it into ONE group and leaves the other sharing groups showing a
spurious NEGATIVE depreciation equal to their own registered dep.

**How to apply:** compute the depreciation residual **per accum account**, not per
group: `residual = accumGLmovement − Σ(regDep of EVERY cost group that uses this
accum)`, then attribute the single residual to that accum's deterministic *primary*
cost group. Cost side has no such trap because cost accounts ARE the group keys
(each cost account maps to exactly one group). Only `status='posted'` JEs count;
branch-scope both the assets list and the GL lines via `branchScopeSpread`.
