---
name: Menu-permission frozen default-on baseline + industry screen exclusions
description: New module keys default OFF for existing companies; industries carry per-screen nav exclusions applied at register.
---

**Rule 1 — frozen baseline:** the legacy "missing menu key = allowed" fallback is limited to FROZEN snapshot sets (2026-08): `LEGACY_DEFAULT_ON_MENU_KEYS` (menuItems.ts, used by Layout parseMenuPerms + MenuPermissions defaults) and `LEGACY_DEFAULT_ON_GATE_KEYS` (companyModuleGate.ts frontend + api-server middleware/permissions.ts backend). A module/gate key added AFTER the snapshot defaults OFF when absent from a company's saved menu_permissions.
**Why:** new platform modules must never auto-appear (or auto-authorize API access) for pre-existing companies; SA enables them per company from صلاحيات القوائم.
**How to apply:** when adding a NEW module key, do NOT add it to the frozen sets — add it only to the normal catalogs/gates. `nav:*` screen overlay stays default-on, so new screens inside an already-enabled module still auto-appear. All four spots must express the same default or the editor and runtime diverge.

**Rule 3 — catalog parity:** every MENU_ITEMS key must ALSO be in api-server `menuPermissionCatalog.ts` CANONICAL_MENU_PERMISSION_KEYS, or /register's explicit-deny fill skips it and the frozen baseline shows the module to new tenants (2026-08 leak: delivery_receipt_docs, safety, voice_assistant, sessions, company_maintenance, office, training_room). Likewise MODULE_GROUPS screens must mirror Layout.tsx nav hrefs exactly (nav:<path> matching is string-exact), or screens are missing from the industries picker.

**Rule 2 — industry screen exclusions:** `industries.hidden_nav_paths` (jsonb string[]) lists route paths hidden for NEW companies of that activity; /register writes them as `nav:<path>=false`, with OR semantics across multiple selected industries (hidden only if hidden in ALL). Visibility-only — module API gate untouched. Edited in the Industries dialog via MODULE_GROUPS screen chips (only modules whose keys are selected are listed).
