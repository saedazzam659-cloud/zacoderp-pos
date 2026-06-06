---
name: POS Desktop single installer type
description: Why the online and offline POS Desktop installers must be the SAME installer type (MSI), and how the two-MSI build avoids a filename collision.
---

# POS Desktop — one installer TYPE only (both MSI)

The POS Desktop ships TWO installer variants from one build:
- **online** — small MSI, `webviewInstallMode: downloadBootstrapper` → public `/download` page + in-app updater (DB platform `win-x64`).
- **offline** — large MSI, `webviewInstallMode: offlineInstaller` (full WebView2 embedded) → protected `/install` wizard for no-internet installs (DB platform `win-x64-exe`, name kept for back-compat even though it's now an MSI).

**Rule:** both variants MUST be the SAME installer type (MSI, per-machine, same product/UpgradeCode).

**Why:** when the offline variant was a per-user NSIS `.exe` and the online variant a per-machine MSI, they installed to different locations (`%LOCALAPPDATA%` vs `Program Files`) as separate products. An MSI update could not replace an NSIS install (and vice-versa), so users who installed one path and updated via the other "never updated" — they ended up with two copies. Unifying to MSI-only makes every update cleanly replace whatever is installed.

**How to apply:**
- `tauri.conf.json` `targets` stays `["msi"]`; no `nsis` block. The offline pass is `tauri build --bundles msi --config tauri.offline.conf.json` (the offline config overrides ONLY `webviewInstallMode`).
- Both passes emit `bundle/msi/<identical-name>.msi`, so the CI MUST stash pass-1 output (`staging/online/`) BEFORE pass 2, then rename pass-2 output to `*-offline.msi` (`staging/offline/`). Without the stash, pass 2 overwrites pass 1.
- `githubReleaseSync.ts`: `pickMsiAsset` must EXCLUDE `*-offline.msi` (online pick); `pickExeAsset` prefers `*-offline.msi` then falls back to `*-setup.exe`/`.exe` so historic NSIS releases still mirror. DB platform keys and `/download`+`/install` routes are unchanged.

**Transition caveat (expected, not a bug):** existing per-user NSIS-installed clients hit the conflict ONCE — they need one clean uninstall+reinstall to land on the MSI; future updates are then clean.
