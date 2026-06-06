---
name: POS Desktop old-version cleanup & pinned UpgradeCode
description: Why MSI builds piled up side-by-side, the pinned-UpgradeCode fix, and the startup registry cleanup that bridges the transition.
---

# Side-by-side MSI install conflict

**Symptom:** a machine with an old build (e.g. 0.8.17) installing a newer MSI ended
up with TWO "ZACOD POS" entries in Programs & Features (conflict), while a fresh
machine installed cleanly.

**Root cause:** Windows Installer only auto-replaces a prior install when the new
MSI shares the SAME WiX `UpgradeCode`. Tauri auto-derives that code, and older
builds could carry a different one — so the new MSI installs ALONGSIDE the old one
instead of upgrading it.

## The fix (two parts)

1. **Pin a stable `upgradeCode`** in `tauri.conf.json` (`bundle.windows.wix.upgradeCode`).
   From the pinned version onward every build shares it → atomic major-upgrades, no pile-up ever.
2. **Startup registry cleanup** (`src-tauri/src/cleanup.rs`, winreg, Windows-only):
   scan HKLM + HKLM\WOW6432Node + HKCU `…\Uninstall`, match our product, and
   `msiexec /x {ProductCode} /quiet /norestart` any STRICTLY-older version.

**Why both:** pinning a NEW code means the first pinned build will NOT auto-upgrade
the immediately-preceding (auto-code) build — they coexist after install. The
startup cleanup removes that leftover on first launch, bridging the one-time
transition. All later builds share the pinned code, so cleanup normally finds
nothing.

## Invariants that keep cleanup safe

- **Run at STARTUP, never during the update flow.** The live process is the new
  version, so we only ever remove obsolete copies (never ourselves), and the old
  binaries aren't running → no locked-file races, no sequencing problem.
- **Remove STRICTLY-older only** (numeric compare), not just `!= current`. Equal =
  the live install; newer = a coexisting build we must not touch.
- **Sequential `msiexec /x` with `.status()` (wait).** Windows Installer is a single
  global mutex; concurrent uninstalls collide with 1618. Tolerate 1618/non-zero as
  retry-next-launch — cleanup runs every boot, so it converges.
- **Only act on MSI `{GUID}` product codes** (the uninstall subkey name is the GUID
  for MSI); skip EXE/other entries we can't silently uninstall.
- **Non-elevated `/quiet` uninstall of a per-machine product may fail** — that's
  expected and non-fatal; it retries next launch or needs a manual/elevated removal.

**Why:** a registry-scan auto-uninstaller is security-sensitive; the strictly-older
+ live-version-skip + GUID-only guards are what stop it from ever bricking the
running app or removing an unrelated product.
