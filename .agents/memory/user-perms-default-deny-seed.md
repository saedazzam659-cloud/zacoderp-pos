---
name: User permissions form must seed default-DENY
description: Web ERP user-permissions form must seed from emptyPermissions(), never viewOnlyPermissions(), or edits silently grant view on every module.
---

The web ERP (`Users.tsx`) user-permissions form must seed the permission map from
`emptyPermissions()` (all module keys present, NO actions), not
`viewOnlyPermissions()` (view:true on every module).

Three seed points must all use the empty base:
- new-user default (`emptyForm`)
- edit load merge base (`openEdit`: `{ ...emptyPermissions(), ...saved }`)
- copy-from-user base (`copyPermissionsFrom`)

**Why:** if the base is view-all, merely OPENING then SAVING any user re-grants
`view:true` on every module and persists it — so a user "granted HR only" ends up
seeing Cash/Security/ZATCA etc. in the sidebar (`Layout.tsx` gates non-admins on
`!!perm?.view`). This is a silent least-privilege breach, not a visible bug in the
matrix.

`emptyPermissions()` still returns `{ [moduleKey]: {} }` for every PERMISSION_MODULE,
so the checkbox matrix renders (unchecked) and toggling/group actions keep working.
`viewOnlyPermissions()` legitimately stays as the "عرض فقط" preset.

**How to apply:** any new form/flow that pre-populates a user's permission map must
base on `emptyPermissions()`. Existing users already persisted with view-all are NOT
auto-healed by the code fix — they must be re-edited (use "إلغاء الكل" preset, pick
the wanted modules, save) or cleaned via a controlled admin script.
