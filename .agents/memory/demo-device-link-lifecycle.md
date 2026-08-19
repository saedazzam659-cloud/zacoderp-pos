---
name: Demo device isolation — per-device policy + cookie binding
description: Active demo policy is per-device isolated workspaces (strict single-browser was reverted); every session, including shadow, must present the HttpOnly browser cookie.
---

Active policy (reverted from strict single-browser after it locked out a legitimate production user):

- **Per-device isolation**: every browser logging into a `demoDeviceIsolation` account gets its own workspace. First device = primary, works inside the source company. Each additional device gets a hidden cloned company ("… — ديمو جهاز N") + a shadow user. No pair codes — `createDemoPairCode` stays 410-disabled; a new cookie token simply means a new isolated workspace.
- **Cookie binding kept from the strict era**: the per-browser token lives in an HttpOnly `zacode_demo_browser` cookie and is re-verified on EVERY authenticated request in the bearer resolver — for the source/primary user (`verifyStrictDemoBrowserBinding`) AND for shadow sessions (`resolveDemoShadowBinding` matches the cookie hash against the link that owns the shadow user). A copied bearer token alone is useless.

**Why:** strict mode punished normal users (new browser/cleared storage = locked out, 423) while the cookie check alone already blocks token theft; per-device isolation also keeps demo data from cross-contaminating.

**How to apply:**
- Login compensation on session-write failure must `releaseDemoDeviceLink` (DELETE the link row + deactivate shadow), never `revokeDemoDevice` — revoking permanently locks that browser out because its cookie survives.
- `decorateDemoShadowUser` must resolve `demoSourceUserId` from the ready, non-revoked link; if it returns undefined the middleware rejects every shadow session.
- Revoking a device must clear the workspace user's sessionToken/sessionId (and deactivate shadows) so old bearers die even with the old cookie.
- All login/link mutations serialize on `pg_advisory_xact_lock(90_000_000 + sourceUserId)`.
- SameSite=None seen in the Replit preview is proxy rewriting, not a bug.
