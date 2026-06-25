---
name: Extension Platform foundation (Phase 0 outer shell)
description: How the additive partner-extension subsystem is wired so partners extend Zacode without touching/seeing core.
---

# Extension Platform — Phase 0 ("outer shell")

Additive subsystem letting partners build on the ERP WITHOUT modifying or seeing core. Default OFF for every tenant.

## Hard invariants (do not break)
- **Sandbox**: partner screens render in an iframe whose `sandbox` is `allow-scripts allow-forms` — NEVER add `allow-same-origin` (that would let the partner page reach parent origin / cookies).
- **No code from DB**: the DB row carries only the SIGNED manifest + enable state. Executable handlers live ONLY in the in-process `BUILTINS` map (registry.ts). Never eval/load code from a manifest.
- **Signature gate**: every manifest is Ed25519-signed (canonical JSON). `getActiveExtensions` REFUSES any row whose stored signature fails `verifyManifest`. Tampering the catalog row → rejected.
- **Lazy platform init**: `ensureExtensionPlatform()` (keypair + seed) runs on FIRST endpoint hit, NOT at boot — so an empty `platform_extensions` right after restart is normal until an /ext endpoint is touched.

## Gating (default OFF) lives in 4 places — keep in lockstep
- backend `permissions.ts`: `extensions_platform` in COMPANY_MODULE_GATE + MODULE_GATE_DEFAULT_OFF; `extensions` user perm.
- frontend `companyModuleGate.ts`: same module key + default-off.
- frontend `permissions.ts`: `extensions` perm module.
- `Layout.tsx`: a new top-level nav group needs ALL of — prop in interface AND in the destructuring params, `GROUP_PERMISSION_KEYS.extensions`, `"extensions"` in the `TopLevelGroup` union, an entry in `setterByGroup`, a line in `closeOtherTopLevelGroups`, and the render block. Missing the destructuring or the union entry = tsc fail; missing GROUP_PERMISSION_KEYS = white-screen for non-SA.

## DDL gotcha (cost a code-review FAIL once)
The 3 tables (`platform_extensions`, `company_extensions`, `ext_data`) are CREATE-TABLE-IF-NOT-EXISTS'd in **`artifacts/api-server/src/lib/ensureSchema.ts`** (NOT src/db/). There must be EXACTLY ONE DDL block, matching `lib/db/src/schema/extensions.ts` (the Drizzle schema declares NO `.references()` FK — so the DDL should not add FKs either). A duplicate block with divergent DDL makes the fresh-DB shape non-deterministic.
**Why:** grepping the wrong path (src/db vs src/lib) hid the existing block and led to a duplicate.
