// ─────────────────────────────────────────────────────────────────────────
// Windows module gate (Task #226)
//
// Resolves whether a given PosShell screen ("view") should be visible, by
// combining TWO independent gates on top of the existing per-user permission
// check (see lib/permissions.ts `can()`):
//
//   1. PROFILE gate  — the first-run "POS only vs Full ERP" choice. A machine
//      set up as "pos" never shows ERP-only screens, regardless of cloud flags.
//   2. CLOUD MODULE gate — the per-company { <module>: boolean } map pushed by
//      the SuperAdmin through /api/sync/pull. A module set to `false` hides
//      every view that rolls up to it. Only meaningful in CLOUD mode — a
//      standalone device has no cloud link, so it ignores this gate.
//
// Missing/legacy data fails OPEN (enabled) so existing installs are never
// locked out by a key that simply isn't present yet.
// ─────────────────────────────────────────────────────────────────────────

import { moduleForView, profileForView, type WindowsView, type AppProfile } from "./moduleRegistry";

const LS_FLAGS = "pos_desktop_windows_modules";

/** Persist the cloud-pushed module flags (called from sync.ts after a pull). */
export function saveWindowsModuleFlags(flags: Record<string, boolean> | null | undefined): void {
  try {
    if (flags && typeof flags === "object") {
      localStorage.setItem(LS_FLAGS, JSON.stringify(flags));
    }
  } catch { /* storage full / unavailable — non-fatal */ }
}

/** Read the last cloud-pushed module flags. Empty object when none yet. */
export function loadWindowsModuleFlags(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_FLAGS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/** True when the company has NOT explicitly disabled `module` (fail open). */
export function moduleAllowedByCloud(
  module: string,
  flags: Record<string, boolean> = loadWindowsModuleFlags(),
): boolean {
  return flags[module] !== false;
}

type GateOpts = {
  /** Active app profile (null = treat as full ERP for backward compat). */
  profile: AppProfile | null;
  /** Standalone mode skips the cloud gate (no cloud link to push flags). */
  standalone: boolean;
  /** Pre-loaded flags (avoids re-reading LS on every nav item). */
  flags?: Record<string, boolean>;
};

/** Master visibility gate for a Windows screen (profile + cloud module). */
export function isModuleEnabled(view: WindowsView, opts: GateOpts): boolean {
  // 1) Profile gate — "pos" hides ERP-only screens.
  if (opts.profile === "pos" && profileForView(view) === "erp") return false;
  // 2) Cloud module gate — cloud mode only.
  if (!opts.standalone) {
    const flags = opts.flags ?? loadWindowsModuleFlags();
    if (!moduleAllowedByCloud(moduleForView(view), flags)) return false;
  }
  return true;
}
