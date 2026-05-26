---
name: POS Desktop standalone-mode boot branching
description: Why the standalone path must never touch cloud helpers, and the trap to avoid when adding new shell features.
---

# POS Desktop has TWO completely separate boot trees (cloud / standalone)

When standalone mode is active, the App.tsx state machine never enters
the cloud phases (`needs-activation` / `needs-cashier` / `signed-in`)
and PosShell receives `standalone=true` with `api=null`.

**Rule:** every cloud-only effect/action in PosShell (heartbeat,
pending-invoices count, pull, push, deactivate, updates banner) must
guard on `if (standalone || !api) return;` — or it will crash the
standalone branch with `Cannot read properties of null (reading 'heartbeat')`
the moment a 30s interval fires.

**Why:** standalone has no cloud URL, no device token, no user token,
no `pos_sessions` row, no upload queue. Treating it as "cloud-with-bad-network"
silently leaks identifiers (machine fingerprint, license key) to
whatever DNS the OS happens to have, which defeats the whole product promise.

**How to apply:** when adding a new shell feature that talks to the network,
either (a) gate it on `!standalone`, or (b) route it through a function that
checks `getAppMode()` and short-circuits. The license file itself never goes
to any network — it's verified entirely client-side against the public key
embedded at build time via `VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64`.

# Signing format gotcha

The Ed25519 signature signs the **base64 string of the payload**, not the
canonical JSON. Both signer (`offlineLicenseSigner.ts`) and verifier
(`standalone.ts → verifyLicenseFile`) must agree on this or every license
is rejected with "signature failed". JSON canonicalization is famously
underspecified, so signing the b64 bytes sidesteps the entire issue.

# Revocation is informational only

`POST /admin/offline-licenses/:id/revoke` flips the DB row to `revoked`
but cannot reach the customer's offline machine. Treat revocation as an
audit/billing signal, not a kill switch. If a license must be killed
in the field, you have to rebuild the app with a new public key and
push a manual update.

# Standalone local-auth threat model

Local user accounts live in `localStorage` under `pos_desktop_standalone_users`
hashed with PBKDF2-SHA256 (100k iters, per-user random salt). The session
blob in `pos_desktop_standalone_session` is plain JSON — `loadLocalSession`
re-validates it against the user store on every boot to block the most
naive forgery (fake session for nonexistent user), but it is NOT
tamper-proof against an attacker with full LS write access (they can
just create a matching admin user row). Real protection comes from
OS-level ACLs on the Tauri `%APPDATA%` directory; the browser-preview
build is intentionally weaker because it's for dev only. Do not promise
"secure" auth on the browser path.

# Mode-switch wipe must be exhaustive

`wipeStandalone()` iterates every `pos_desktop_*` LS key — never write
a targeted "remove these 4 keys" wipe, because the next feature added
to standalone will silently survive a mode switch and leak prior-tenant
data into the new boot tree. If standalone ever starts persisting to
SQLite, add a Tauri command to drop the DB file from the same wipe.
