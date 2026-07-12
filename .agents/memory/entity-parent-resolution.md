---
name: Entity parent-account resolution
description: How supplier/customer AP-AR group parents are resolved from a tenant COA — exact-code-first, never nest under a leaf.
---

**Rule:** when resolving the group account to nest a new party sub-account under (entityAccounts `resolveEntityParent`), a `LIKE 'prefix%'` hit is NOT trustworthy — it matches the group's own children (`21011%` → `2101101…`) and whole subtrees (`2101%`). Resolution order must be: (1) EXACT code match per prefix in priority order, (2) ordered name-like match (category-specific names first, shortest code wins ties), (3) shortest-prefix hit only as a last resort for unrecognizable COAs.

**Why:** shortest-startsWith alone picked the generic 2101 parent for both local and foreign suppliers (prefix "2101" matched the parent itself before "21011"/"21012" were tried in the right order), and in COAs missing the group node it could pick a LEAF supplier account as parent, corrupting numbering.

**How to apply:** supplier prefixes/name-likes are category-aware functions (local → 21011/محلي first; foreign → 21012/خارجي/أجانب first, generic appended). Any new party type (or category) gets its own ordered prefix+name lists; keep peek and creation on the same shared resolver so the UI hint can never diverge from what save mints. Explicit user-picked parents must be tenant+type-guarded and fall back to the heuristic identically in BOTH the peek (GET) and create (POST) paths.
