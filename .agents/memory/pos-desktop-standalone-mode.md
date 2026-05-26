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

Desktop build: local users + license + mode + session live in **SQLite**
(`pos.db` under `%APPDATA%\ZACOD-POS`, ACL-restricted to the current user)
via Tauri commands in `src-tauri/src/standalone.rs`. Passwords are
**bcrypt cost-12**. Session is JSON in `app_settings.standalone_session`
and `standalone_load_session` re-validates it against `local_users` on
every boot to block the naive "fake session for nonexistent user" forgery.

It is NOT tamper-proof against an attacker with full filesystem write
access (they can replace the whole `pos.db`). SQLCipher is intentionally
deferred — see `windows-openssl-trap.md` for why bundling SQLCipher on
Windows CI is a build-trap. Defense in depth comes from OS ACLs on
`%APPDATA%`, not from the DB itself. Do not promise "encrypted-at-rest"
in standalone marketing copy until SQLCipher (or a Rust-native AES wrap)
is actually in place.

Browser-preview build (Vite dev, no Tauri) falls back to localStorage +
PBKDF2-SHA256 (100k iters). This path is intentionally weaker — it's a
dev convenience, not a shipping surface. `lib/standalone.ts` detects the
runtime via `__TAURI_INTERNALS__`/`__TAURI__` and branches.

# Mode-switch wipe must be exhaustive

Two layers must both be cleared on every wipe:
1. SQLite — `standalone_wipe_all` empties `local_users`, `local_license`,
   `app_settings`, **and** `parked_carts`, `offline_invoices`, `customers_local`,
   `items_local`. Never write a targeted "drop these 3 tables" version — the
   next feature added to standalone will silently survive a mode switch and
   leak prior-tenant data into the new boot tree.
2. localStorage — `wipeStandalone()` still iterates every `pos_desktop_*`
   key, because the dev/browser fallback writes there and some legacy keys
   (cashier context, server URL) may have leaked in.

# Public-key pinning fails closed in production

`VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64` empty + `import.meta.env.PROD` → the
verifier returns an error and refuses every license. Empty + dev → accept-any
with a banner. Do not "fix" the dev path by failing closed there too —
local devs without the keypair would be unable to test the flow at all.
