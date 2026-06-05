---
name: POS Desktop in-app update install step
description: Why "update installs but app stays on old version" happens and the install-side invariants for the Tauri MSI self-updater
---

# POS Desktop self-update install invariants

Symptom seen once: updater downloaded the correct newer MSI, server served the
right version, yet the running app stayed on the OLD version (new post-build
features never appeared). The file was fine — the **install step** silently
failed. Two independent causes, both must be guarded:

**Rule 1 — the MSI is PER-MACHINE, so the installer must run ELEVATED.**
Tauri's MSI target defaults to a per-machine install (only the NSIS `.exe` is
`currentUser`). The in-app updater uses the small ~5MB MSI (NSIS bundles
WebView2 → ~200MB, far too big to re-download per update). `msiexec /i` spawned
from the non-elevated app with no exit-code check silently fails (error 1925 —
"insufficient privileges for all users") on any account without auto-elevation
(notably a fresh laptop / standard user). Launch it elevated (`Start-Process
... -Verb RunAs`) so the user gets a UAC prompt and the install actually has
privileges.
**Why:** a denied/absent elevation leaves the old version with zero error
surfaced to the user.

**Rule 2 — the app must FULLY EXIT before msiexec touches files.**
A major upgrade has to overwrite the in-use `ZACOD POS.exe`. If msiexec is
spawned while the app is still alive and the bundle uses `/norestart`, the
upgrade hits in-use files and ROLLS BACK → stays on the old version. Correct
order: spawn a detached helper that waits (`Start-Sleep`) for this process to
die, THEN runs msiexec; exit the app immediately after spawning. Do NOT spawn
msiexec and exit "a second later".

**Rule 3 — always pass `/l*v <log>` and escape PowerShell args.**
Verbose install log in `%TEMP%` is the only post-mortem you'll have (no local
Windows/cargo to reproduce). When building the PowerShell `-Command` string,
escape `'` → `''` in any filesystem-derived value — `%TEMP%` contains the
username and usernames can legally contain apostrophes (`O'Connor`).

**Build-pipeline corollary — pin version FROM the git tag.**
The MSI ProductVersion + in-app `__APP_VERSION__` come from the COMMITTED
version files, not the tag. A `pos-desktop-vX.Y.Z` tag cut on a commit whose
version files say something else ships an MSI that advertises the WRONG version
(happened with `pos-desktop-v0.8.12`). The build workflow must rewrite
package.json / tauri.conf.json / Cargo.toml from the tag before building.

**Recovery when a fleet is already stuck on an old build:** the broken updater
is the one currently installed, so it can't self-heal. The user must release a
new version and MANUALLY install it once as administrator; only builds that
CONTAIN the fixed updater self-update correctly afterward.
