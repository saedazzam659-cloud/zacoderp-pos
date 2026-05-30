---
name: POS Desktop dual installer (small MSI vs large offline one-click EXE)
description: How /download (small MSI), the in-app updater, and /install (large offline NSIS EXE) serve different installer flavors via two build passes.
---

# Two installer flavors, keyed by the `platform` column — built in TWO passes

The POS Desktop app ships two installer formats, intentionally different sizes:

- **`.msi` (small ~4.5MB, `downloadBootstrapper`)** → `download_releases.platform = "win-x64"`
  → served by the **public `/download`** page (`public-download.ts`) **AND consumed by
  the in-app updater** (frontend `lib/updates.ts` / `UpdatesScreen.tsx` query
  `platform=win-x64`; `updater.rs` downloads + passively installs it).
- **NSIS one-click `.exe` (large ~195MB, `offlineInstaller`)** → `platform = "win-x64-exe"`
  → served by the **gated `/install` wizard** (`download-wizard.ts`).

**Why two sizes:** the user wants `/download` + auto-update to be SMALL (WebView2
fetched at install — and it is already present on any machine running the app, so an
update never downloads it), while `/install` is the LARGE fully-offline installer for
air-gapped POS machines.

# The single-build constraint and the fix

`bundle.windows.webviewInstallMode` is **global per Tauri build** — one
`tauri build --bundles msi nsis` gives BOTH bundles the SAME WebView2 mode. So you
**cannot** get a small MSI and a large offline EXE from one build pass.

**Fix (in `.github/workflows/pos-desktop-build.yml`):** build in TWO passes.
- Base `tauri.conf.json` keeps `webviewInstallMode.type = downloadBootstrapper`.
- Pass 1: `tauri build --bundles msi` → small MSI.
- Pass 2: `tauri build --bundles nsis --config src-tauri/tauri.offline.conf.json`
  where the override file sets `webviewInstallMode.type = offlineInstaller` → large EXE.
- Both passes write into the same `target/.../bundle/{msi,nsis}` dirs, so the existing
  "Find produced MSI/NSIS exe" steps still locate each one. Doubles Windows-runner time.

**How to apply:**
- No schema change to add a flavor — `platform` text column is the discriminator.
- `githubReleaseSync.ts` auto-mirrors BOTH assets hourly (ALL country); the `.exe`
  mirror is best-effort (try/catch) so a failed exe never blocks the `.msi` publish.
- `/install` wizard resolves via fallback chain `win-x64-exe -> win-x64`, so it serves
  the MSI until the first EXE-producing build lands.
- Changing webviewInstallMode affects EVERY bundle in that pass — if you ever go back
  to one pass, /download and /install will be forced to the same size again.
