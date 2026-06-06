---
name: POS Desktop in-app update install step
description: How the Tauri MSI self-updater must launch the installer, and the hidden-PowerShell trap that silently breaks it
---

# POS Desktop self-update install invariants

The in-app updater downloads the small ~5MB **MSI** (the NSIS `.exe` bundles
WebView2 → ~200MB, far too big to re-download per update) and must launch it so
the upgrade actually replaces the running app.

**Rule 1 — launch `msiexec` DIRECTLY. Never wrap it in hidden PowerShell.**
The correct, production-proven call is:
`msiexec /i <downloaded.msi> /passive /norestart /l*v <%TEMP%\zacod-pos-update-install.log>`
spawned directly, then exit the app ~700ms later. The Windows Installer service
(`msiserver`) takes ownership of the install the instant msiexec starts, so the
upgrade finishes even though the app exits right after, and msiexec auto-prompts
UAC for the per-machine MSI when elevation is needed.

**Why:** A "reliability improvement" shipped after 0.8.11 replaced the direct
call with `powershell -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process
msiexec -Verb RunAs ..."`. A **hidden shell that sleeps then spawns an elevated
installer is a textbook malware pattern** — Windows Defender / EDR silently
terminates it, so the installer NEVER runs and the app stays on the old version.
This is the exact regression behind "updates always worked, then stopped ~2 days
after 0.8.11." The user confirmed the plain msiexec version worked for months.

**How to apply:** keep the install step a single direct `std::process::Command::
new("msiexec")` spawn. Do NOT add `-Verb RunAs`, `-WindowStyle Hidden`, a
PowerShell intermediary, or an artificial `Start-Sleep` before launch. Verbose
`/l*v` log is fine and benign — keep it for post-mortem (no local Windows/cargo
to reproduce). If a genuine elevation problem ever resurfaces on standard-user
accounts, prefer an MSI manifest/ALLUSERS fix over re-wrapping in a shell.

**Build-pipeline corollary — pin version FROM the git tag.**
The MSI ProductVersion + in-app `__APP_VERSION__` come from the COMMITTED version
files, not the tag. A `pos-desktop-vX.Y.Z` tag cut on a commit whose version
files disagree ships an MSI advertising the WRONG version (happened with
`v0.8.12`). The build workflow rewrites package.json / tauri.conf.json /
Cargo.toml from the tag before building, so the tag is authoritative.

**Recovery when a fleet is already stuck on a broken-updater build:** the broken
updater is the one currently installed, so it can't self-heal. Ship a new version
and MANUALLY install it once; only builds that CONTAIN the fixed updater
self-update correctly afterward.
