---
name: GROUP_PERMISSION_KEYS must cover every isGroupAllowed group
description: Adding a sidebar group to Layout.tsx requires a matching GROUP_PERMISSION_KEYS entry or the whole authenticated app white-screens
---

# Every `isGroupAllowed(menuPerms, "<group>", …)` needs a GROUP_PERMISSION_KEYS entry

In `artifacts/zatca-invoicing/src/components/Layout.tsx`, the sidebar renders each
top-level group behind `isGroupAllowed(menuPerms, "<group>", isSuperAdmin, user)`.
That helper does `const keys = GROUP_PERMISSION_KEYS[group]; keys.some(...)`.

**Why:** If you add a new sidebar group (e.g. the OSH/`safety` module) and call
`isGroupAllowed(..., "safety", ...)` but forget to add `safety` to the
`GROUP_PERMISSION_KEYS` map, `keys` is `undefined` and `keys.some(...)` throws
`TypeError: Cannot read properties of undefined (reading 'some')`. Because
superadmins short-circuit at the top of `isGroupAllowed`, this crashes ONLY for
logged-in non-superadmin users — a blank white page in production while the
logged-out landing page still renders fine. This caused a real outage.

**How to apply:**
- When adding any new sidebar group, add its key to `GROUP_PERMISSION_KEYS` in the
  SAME change. The key set must list the company-gate toggle key (matches
  `companyModuleGate.ts` / `MENU_ITEMS`) PLUS the per-user RBAC permission keys
  (matches `lib/permissions.ts` `PERMISSION_MODULES`). For safety that is
  `["safety", "safety_dashboard", "safety_risk", "safety_incidents"]`.
- `isGroupAllowed` now falls back to `GROUP_PERMISSION_KEYS[group] ?? []` so a
  missing key hides the group instead of white-screening — keep that guard.
- This is the same family as the `module-gate-sync` lesson: new module keys must
  be registered in multiple parallel maps or something silently (here, loudly)
  breaks.

## Roll-up-gated groups MUST still list the granular per-user keys (silent-hide failure)

If a group's company gate is a SINGLE roll-up key (e.g. `hr_module` gates all of
`hr_employees`/`hr_attendance`/…/`hr_settings`) but its `GROUP_PERMISSION_KEYS`
entry lists ONLY the roll-up key(s) (`["hr","hr_module"]`), the group SILENTLY
DISAPPEARS for every non-admin user that has any permission configured.

**Why:** `isGroupAllowed`'s per-user branch is
`keys.some(k => menuPerms[k]===true && userPerms[k]?.view===true)`. A regular
user's RBAC map only ever contains the GRANULAR keys (`hr_employees` etc), NEVER
the roll-up keys (`hr`/`hr_module`). So if the key list has no granular keys, the
overlap is empty → `.some()` is always false → group hidden. Admins short-circuit
earlier so they never notice; only role=user is affected (no white-screen, just a
missing sidebar group). Fixed HR by expanding its entry to include all granular
`hr_*` keys, matching the working `safety` pattern.

**How to apply:** for any roll-up-gated group, the `GROUP_PERMISSION_KEYS` entry
must include the granular per-user keys, not just the company-gate roll-up. The
inner `*NavGroup` still enforces company-disable via `groupVisible`/
`companyAllowsModule`, so the outer gate passing on Proxy-default-true granular
keys is safe (one known cosmetic edge: an empty top-nav dropdown label when the
company disables the module while a user retains granular view — pre-existing for
`safety`, accepted). Do NOT "fix" this by making `isGroupAllowed` use
`companyAllowsModule` globally — groups keyed by non-gate roll-up VALUE strings
(`zatca`, `inventory`, `dashboard`) would then ignore their explicit disable.
