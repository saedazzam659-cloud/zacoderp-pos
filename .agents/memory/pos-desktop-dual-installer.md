---
name: POS Desktop dual installer (MSI vs one-click EXE)
description: How /download (MSI) and /install (NSIS one-click EXE) serve different installer flavors of the same POS Desktop build.
---

# Two installer flavors, one build, keyed by the `platform` column

The POS Desktop app ships in two installer formats from the SAME tagged build:

- **`.msi`** → `download_releases.platform = "win-x64"` → served by the **public
  `/download`** page (`public-download.ts`, default platform `win-x64`).
- **NSIS one-click `.exe`** → `platform = "win-x64-exe"` → served by the **gated
  `/install` wizard** (`download-wizard.ts`, default platform `win-x64-exe`).

The NSIS exe is configured per-user (`installMode: currentUser`, no admin/UAC) with
`webviewInstallMode: offlineInstaller` so it installs without internet — Chrome-like
one-click feel, and consistent with the app being offline-first.

**Why:** a website can never silently install a program (Windows security — even
Chrome makes you run a downloaded stub). NSIS per-user one-click is the closest
practical experience; MSI stays for the public page so existing installs/enterprise
deployment are unaffected.

**How to apply:**
- No schema change is needed to add an installer flavor — the `platform` text column
  is the discriminator. Add a new platform string + a `download_releases` row.
- `githubReleaseSync.ts` auto-mirrors BOTH assets hourly (ALL country). The `.exe`
  mirror is **best-effort (try/catch)** so a missing/failed exe never blocks the
  authoritative `.msi` publish.
- The `/install` wizard resolves via a **fallback chain `win-x64-exe -> win-x64`**
  (`resolveWizardRelease`), so it keeps working (serving the MSI) until the first
  EXE-producing build is released. Keep this chain if you add more flavors.
- The feature only reaches installed machines after a new tagged build is published
  (no in-app auto-updater exists; updates = "publish a new tag", mirrored to the same
  Releases table).
