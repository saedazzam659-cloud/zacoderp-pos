---
name: Durable server prefs vs LS cache (tenant-switch safe)
description: How to layer a durable per-user server preference blob over a localStorage cache without a SuperAdmin tenant switch echoing stale state upstream.
---

# Durable server-side UI prefs layered over a localStorage cache

Pattern used for per-screen layout prefs (column order/hide/colors/page size) that
must survive a browser cache wipe: an instant LS cache for first paint, plus a
per-user durable copy in `users.ui_preferences` (jsonb), delivered on
`/api/auth/me` and written via a debounced `PUT /api/auth/me/ui-prefs`.

## The rule
Gate the upstream (debounced) **save** effect on `hydratedKey === currentTenantKey`,
comparing a STATE value at effect-run time — never a boolean that another effect
flips later in the same commit, and never a ref captured then mutated.

- `hydratedKey` = the tenant key (`String(cid ?? "anon")`) we have already applied
  the server copy for. The hydrate effect sets it; the cid-rehydrate effect clears
  it to `null` on tenant change.
- The save effect computes `key = String(cid ?? "anon")` fresh and `return`s early
  unless `hydratedKey === key`.

**Why:** With a boolean `serverSyncReady` flipped by a separate effect, on a `cid`
change all three effects (LS-rehydrate, server-hydrate, save) run in the SAME
commit. The save effect's closure still holds the PREVIOUS render's state, so it
could `setTimeout` a PUT of the *old* tenant's layout before the gate reset takes
effect — clobbering the new tenant's durable copy. Comparing a key (not a
capture-then-flip flag) makes the stale write structurally impossible.

**How to apply:** Any screen that mixes an LS cache + durable server prefs under
SuperAdmin acting-company switching (`zatca_acting_company_id`, see replit.md
"Acting-Company Impersonation"). Seed `lastSavedRef` with the applied blob (or the
DEFAULT layout when no blob exists) so an untouched grid never writes, but an
existing LS-only custom layout still gets pushed on first change. Server copy wins
over LS on load (hydrate effect runs after / overwrites the LS-rehydrate setState).
Hiding columns is view-only — exports keep ALL columns, not `visibleColumns`.
