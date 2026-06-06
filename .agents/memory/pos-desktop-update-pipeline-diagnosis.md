---
name: POS Desktop update pipeline — where "stuck on old version" really lives
description: Decision tree for diagnosing "the app never updates" reports; server pipeline vs client install-replacement.
---

# "The desktop app never updates past vX" — diagnosis order

The server-side release pipeline has THREE stages, all of which normally work.
Verify them with DATA before blaming any of them, and before touching code:

1. **Build/publish**: `GET https://api.github.com/repos/saedazzam659-cloud/zacoderp-pos/releases?per_page=12`
   — confirm the target `pos-desktop-vX.Y.Z` exists, `draft=false`, and has BOTH
   `*_x64_ar-SA.msi` (~4-5MB) and `*_x64-setup.exe` (~198MB) assets. CI publishes as
   `draft: true`, so a release the user forgot to **Publish** on GitHub stays invisible
   to the sync (it filters `!rel.draft` against the PUBLIC api → drafts excluded).

2. **Server sync → `download_releases`**: the hourly `githubReleaseSync` mirrors the
   newest published tag into `download_releases` (country=ALL, platform `win-x64` for the
   .msi + `win-x64-exe` for the .exe; flips the prior active row to `is_active=false`).
   It runs ~hourly with a 1-min startup delay, so a release published minutes after the
   last tick can lag up to ~1h. **The DEV database (DATABASE_URL here) lags PROD** — always
   check PROD: `executeSql({ environment: "production", sqlQuery: "SELECT platform,version,is_active FROM download_releases WHERE is_active=true" })`.

3. **Client install** — this is where the recurring "stuck on 0.8.11" actually lives.

**Why:** In one long debugging session, prod `download_releases` already had 0.8.16 active
and GitHub had 0.8.16 fully published with both assets — the whole server pipeline was
perfect. The app even showed "0.8.16 متاح". Yet the user's machine kept running 0.8.11
after installing BOTH the .msi and the .exe.

**Root cause of the client problem:** two installer identities that do NOT upgrade each
other — the **.msi is per-machine** (WiX, installs to `C:\Program Files\...`) and the
**NSIS .exe is per-user** (`installMode: currentUser`, installs to `%LOCALAPPDATA%\...`).
Installing one on top of the other leaves the OLD copy intact; the user keeps launching
the old shortcut/pinned-taskbar icon → still the old version. The in-app updater uses the
.msi. So mixing the /install (.exe) wizard with in-app (.msi) updates strands the user.

**How to apply:**
- The version chip + header read `APP_VERSION` (vite define). On the running 0.8.11 build
  the header literal was a stale hardcoded "v0.7.15" (fixed in later builds); the
  "الإصدار الحالي المُثبَّت" value is the TRUE running-binary version — trust it.
- Client fix: close app → uninstall ALL "ZACOD POS" entries in Add/Remove (can be 2-3) →
  delete leftover `C:\Program Files\ZACOD POS` + `%LOCALAPPDATA%\ZACOD POS` → delete all
  shortcuts → reboot → install ONE type (.msi, matching the in-app updater) → launch only
  its new shortcut.
- Foolproof "which copy am I running?": right-click the shortcut → Open file location.
- Permanent fix (needs approval + build cycle): ship a SINGLE installer type so .msi/.exe
  can never diverge.
