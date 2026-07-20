---
name: Trainee module permissions
description: How trainee (متدرب) permissions must be shaped for shared vs separate training environments
---

Two different permission stores, two different shapes:

- **Separate mode** (sandbox training company): company-level `menuPermissions` — FLAT boolean map over canonical MENU keys (deny-filled).
- **Shared mode** (existing company): the trainee's `users.permissions` — must be RBAC-shaped `{ key: { view, create, edit, delete, post, export } }` over the granular per-user permission keys from zatca-invoicing `lib/permissions.ts` (PERMISSION_MODULES).

**Why:** frontend `usePermission` + Layout strict group check read `userPerms[k]?.view`. Storing a flat boolean map on the user silently hides EVERY sidebar group (the trainee logs in and sees nothing).

**How to apply:** any code granting per-user perms server-side must map high-level trainee module keys (sales/accounting/…) → the granular per-user keys of that group's screens (see `TRAINEE_USER_PERM_KEYS` in trainee-requests router) and emit the action-object shape. Editing an approved trainee via the admin PATCH rewrites the map — that's also the repair path for accounts created with the old flat shape.
