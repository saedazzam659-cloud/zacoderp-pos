---
name: Document archive feature ACL
description: How the "أرشفة المستندات" archive policy + private-file access control must be enforced.
---

# Document archiving (أرشفة المستندات) access control

The archive control center stores policy on `companies.archive_settings` JSONB:
`{ defaultMode: 'local'|'cloud'|'off', screens: Record<screenKey, mode>, allowedUserIds: number[] }`.
Cloud files index in `document_archives` (companyId, screenKey, docKey, objectPath, …).

## Rules (the durable part)

- **Policy must be enforced on EVERY backend op, not just the UI.** The component hiding
  the button / returning null is cosmetic. Each of POST (record), GET (list),
  download, and DELETE independently recomputes: `userAllowed` (admin/superadmin OR
  `allowedUserIds` empty OR includes caller) AND effective mode
  `screens[screenKey] ?? defaultMode ?? 'local'`. POST requires mode==='cloud';
  list/download deny/empty when mode==='off'.
  **Why:** an authenticated tenant user can call the API directly; UI-only gating is a
  broken-access-control bug (caught in review of the first cut).

- **Never serve archived private objects via the raw `/api/storage/objects/*` route.**
  That route has no object-level ACL (only an auth check). Archived files are streamed
  through `GET /api/document-archives/:id/download`, which looks up the row tenant-scoped
  by `(id, companyId)`, re-checks permission + mode, then pipes
  `objectStorageService.downloadObject`. The frontend `openCloud` uses this endpoint with
  `?token=` (a router-level shim copies `?token=` → Authorization BEFORE extractAuth so
  window.open works without a header).
  **Why:** object paths can leak; without the row-ownership gate any known path is
  downloadable cross-tenant.

## How to apply

- Adding a new archived screen: pass a unique `screenKey` to `<JournalScanArchive>` and add
  it to `ARCHIVE_SCREENS` in GeneralSettings.tsx. No backend change needed (policy is generic).
- Any new archive operation must reuse `loadSettings` + `userAllowed` + `modeFor` in
  `routes/document-archives.ts`; do not trust client-sent mode.
