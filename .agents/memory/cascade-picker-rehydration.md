---
name: Two-level cascade picker rehydration
description: How a main→sub chart-of-accounts (or any parent→child) picker must derive its parent selection from the bound leaf value
---

A two-level cascading picker (main account → sub/leaf account) binds its public
`value` to the LEAF id only; the parent ("main") selection is internal UI state
derived from the leaf's `parentId`.

**Rule:** the derive-parent effect must set the parent DETERMINISTICALLY on every
non-empty `value` change — `setMainId(String(sel.parentId))`, NOT
`setMainId(prev => prev || ...)`.

**Why:** with `prev || ...` the parent locks to the first value it ever saw. When
the user navigates between records (edit voucher A → edit voucher B whose leaf
lives under a different main), the parent picker stays stale and the sub list
shows the wrong branch.

**How to apply / the trap:** do NOT also "reset parent when value is empty". The
main-selection flow intentionally clears the leaf (`onValueChange("")`) while
keeping the just-picked parent so the sub dropdown can open — guard the effect
with `if (!value) return;` so an empty value never wipes the parent. So: empty
value → leave parent alone; non-empty value → re-derive parent from its `parentId`.
