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

# Extension Platform — Phase 2 ("runtime & SDK")

Capability layer on the Phase-0 shell. The single seam where extension code reaches core data is the **gated Core Data API** — there is no other path.

## The two data planes (keep separate)
- **Own data** = `ext_records` (added Phase 2): one shared, tenant-scoped table holding ALL extensions' custom "tables". An extension's logical table is a `collection` string; rows live as `ext_records(company_id, extension_id, collection, record_id, data jsonb)`. `dataStore.ts` requires the collection be DECLARED in the signed manifest `tables[]` before any op. No per-extension DDL, ever.
- **Core data** = real core tables, reachable ONLY via `coreDataApi.ts`. A hard-coded `RESOURCES` registry (customers rw, items/invoices/suppliers/accounts r) defines an explicit column projection (no secret/internal cols), FORCES `eq(companyId)` on every query, and honours an action ONLY if `<resource>:<action>` is in the signed manifest `permissions[]` → else `CoreApiError`/403. Server-side handlers (handleApi) must also go through `coreList`/`coreCreate`, so the permission model applies to server code too, not just the browser SDK.

## SDK / sandbox auth
- The browser SDK is INLINED into the screen document (CSP `script-src 'unsafe-inline'`, opaque iframe origin → no external `<script src>`). `renderExtensionDocument()` emits `window.__ZX__` bootstrap (base/extensionId/token) + the SDK source + the app script. `window.Zacode` = `{ ctx, core, data, api }`.
- The sandboxed iframe CANNOT set an `Authorization` header, so the SDK appends the bearer as `?token=`; the router shims `?token=` back into auth. Served publicly at `GET /api/ext/sdk.js`.

## Wiring traps hit this phase
- `req.params.extId` is typed `string | string[]` in this codebase's express types — wrap with `String(...)` (existing `setEnabled` already did) or tsc fails.
- `screens[].kind` and manifest `tables[]` are zod-`.default()`/required on the OUTPUT type, so EVERY builtin manifest literal (helloWorld included) must set `kind` and `tables` or tsc errors at the literal.
- Frontend: a `.filter()` chained directly on an annotated array literal drops the literal's contextual typing → `kind` widens to `string`. Annotate the literal (`[...] as Array<{kind: ExtensionScreenKind;...}>`) BEFORE `.filter`.
- `seed.ts` re-signs + `onConflictDoUpdate`s every builtin manifest on each platform init, so manifest edits (new kind/tables/perms) propagate to stored rows automatically; no manual migration.
- Sample exercising all 4 capabilities = `partnerToolkit.ts` (dashboard+report+notes CRUD screens, `tables:[notes]`, `/summary` API, read-only core perms). Dev docs = `artifacts/api-server/src/extensions/SDK.md`.
- Full `zatca-invoicing` tsc exceeds the 120s bash limit → run via a temp `console` workflow writing to a log; `EXIT=0` + zero `error TS` = clean.
