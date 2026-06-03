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
