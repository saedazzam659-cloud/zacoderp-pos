---
name: POS Desktop clock-rollback guard
description: How the monotonic time guard closes the clock-rollback trial-extension exploit, and why HWM alone is insufficient.
---

# POS Desktop clock-rollback guard

Closes the exploit where rolling the Windows clock backward extends a trial/subscription (expiry checks compared `expiresAt` to the live clock).

## Design
- **All guard logic in TS** (`src/lib/clockGuard.ts`), reusing the SAME `@noble/ed25519` verify + pinned pubkey the offline-license loader uses. Rust (`clock_guard.rs`) owns ONLY a machine-bound AES-256-GCM encrypted file (`zatca_encrypt/decrypt`, made `pub(crate)`), exposed as `clock_guard_file_read/write`.
- **Redundant stores** for `{hwm, locked, nonce}`: SQLite `app_settings.clock_guard_state`, the encrypted file, and (dev) localStorage. Merge = MAX(hwm) / OR(locked) → attacker must defeat every copy.
- **Apply expiry via `effectiveNow = max(systemNow, HWM)`** in BOTH cloud and standalone boot trees (they are SEPARATE trees in App.tsx — guard must run in both, on boot AND a periodic tick). Standalone grace (`isGraceExpired`) also takes effectiveNow, not bare `Date.now()`.
- **Two SuperAdmin-only unlocks**: OFFLINE Ed25519-signed code bound to `fp+nonce+purpose:"clock_unlock"` (zero internet); ONLINE one-click stamps `pos_devices.clock_unblock_at`, device clears via `/validate` or `/sync/pull`. Admin endpoints: `POST /api/admin/pos-devices/generate-clock-unlock` (takes the full `deviceCode`) and `POST /api/admin/pos-devices/devices/:id/clock-unblock`.

## CRITICAL: HWM-vs-wall-clock alone is NOT enough
A persisted high-water-mark compared only to the wall clock can be **frozen**: roll the clock back by ~the elapsed real time each tick so `now` stays just under HWM — HWM never advances, `effectiveNow` freezes, the trial countdown pauses indefinitely. A per-tick "backward jump vs lastSeen" check also fails because the attacker compensates exactly.

**Why:** you cannot detect a perfectly-compensated freeze using only wall-clock-vs-wall-clock comparisons; you need an INDEPENDENT elapsed-time source.

**How to apply:** anchor `performance.now()` (monotonic, immune to system-clock changes) once per session against `max(now, hwm)`, then each tick derive `monoNow = anchorWall + (performance.now() - anchorPerf)` and fold it into both HWM advancement and the backward-jump lock trigger. Even a held wall clock then advances `effectiveNow`, and a sustained freeze trips the lock after ~TOLERANCE (1h). Reset the in-memory anchor on every unlock so the cleared lock rebases. Anchor is in-memory (resets each launch); the persisted HWM covers the cross-restart case.

## Standalone dual-unlock parity (SuperAdmin /admin/offline-licenses)
Both unlocks also live on the Standalone licenses screen (`OfflineLicenses.tsx`), not just `PosDevices.tsx`:
- **OFFLINE generator works for ALL standalone licenses** because `generate-clock-unlock` signs from the pasted `deviceCode` (`fp+nonce`), NOT from a cloud device row — so reuse the SAME pos-devices endpoint; do not build a second one.
- **ONLINE "فك الحظر" is meaningful ONLY for `source='self_register'`** (those revalidate online). Admin file licenses never phone home → online stamp is a silent no-op. Gate the row button to `self_register` AND reject non-self_register server-side (`POST /api/admin/offline-licenses/:id/clock-unblock` → 409) so the UI gate isn't the only guard.
- Device side: self_register clears via the PUBLIC revalidate endpoint (carries `clockUnblockAt`+`serverTime`), NOT `/validate` (that's cloud-device-token only). `ClockTamperLocked` takes an optional `standalone?:{licenseKey}` prop and polls `revalidateLicense → clockGuardClearOnline → clockGuardCheck`.

**Why:** standalone has no device token, so the cloud online-pickup path can't reach it; its only online channel is the license revalidate call.

**How to apply:** in App.tsx build the `standalone` context for `clock-locked` at boot (`loadClockLockStandalone()` = verify license file, only if `source==='self_register'`) AND in the periodic tick from EVERY standalone phase that holds a loaded license (`standalone-signed-in` AND `needs-standalone-login`) — missing a phase means a mid-session lock loses the online path.

## Rust caveat
Rust compiles ONLY in CI — tsc + architect miss Rust errors. Hand-check: `dirs` crate dep, base dir matches `db.rs` (`com.zacoderp.pos`), `pub(crate)` visibility of reused helpers, and that every new command is in `main.rs` `invoke_handler`.
