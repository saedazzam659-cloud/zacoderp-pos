---
name: POS Desktop cloud device-license /validate must enforce expiry server-side
description: Cloud device-license expiry/revocation must be gated by the SERVER /validate endpoint, not only the desktop client; keep /validate and /activate in lockstep and fail closed on a missing binding.
---

Cloud POS Desktop device licenses (`device_licenses` table, `/admin/pos-devices`
screen, `/api/device-licenses/*`) are a SEPARATE system from the standalone
offline `.zacolic` licenses (`offline_licenses`, `/admin/offline-licenses`,
which carry "مهلة عدم الاتصال" / graceDays). Cloud device licenses have **no
grace column** — grace is an offline-only concept.

Rule: the cloud `POST /api/device-licenses/validate` endpoint MUST enforce
license expiry and revoked/expired status server-side (return 403 with
`{ error, expiresAt }`), exactly mirroring `/activate`. It must also fail
closed when the device's `licenseId` is null/unresolvable (403 "license
missing").

**Why:** `/validate` historically always returned `200 {valid:true, expiresAt}`
and never enforced anything, so an expired/revoked cloud license could keep
booting the desktop app. The only gate was the desktop client's local boot
check — which is bypassable, can run an outdated MSI build that lacks the
check, or can see `expiresAt:null` and skip it. A license system must be
authoritative on the server.

**How to apply:** any time you touch device-license lifecycle, keep `/validate`
and `/activate` enforcement in lockstep (status + expiry + binding). The desktop
boot handler already maps a `/validate` 403 to the license-expired / activation
screen (`App.tsx` bootCloud) and reads `e.details.expiresAt` (the client's
`ApiError.details` holds the full JSON body). A server-side fix is deployable
immediately via republish; a client-only fix requires the user to ship + install
a new MSI, so prefer server enforcement.

**Offline caveat (different subsystem):** admin-issued standalone offline
licenses (`source !== 'self_register'`) run 100% offline and intentionally do
NOT revalidate against the server, so editing the SuperAdmin expiry of an
issued offline file does NOT propagate to the device — it only locks when the
device's own cached signed file expires (checked locally in
`verifyLicenseFile`). Only `source === 'self_register'` offline licenses pull a
re-signed file with the new expiry when online.
