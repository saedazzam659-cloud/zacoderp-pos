// ─────────────────────────────────────────────────────────────────────────
// Windows module gate (Task #226)
//
// Resolves whether a given PosShell screen ("view") should be visible, by
// combining TWO independent gates on top of the existing per-user permission
// check (see lib/permissions.ts `can()`):
//
//   1. STANDALONE LICENSE gate — when present, the signed module list is the
//      authority for standalone screens. Legacy licenses without the field keep
//      their previous profile behavior.
//   2. PROFILE gate — the first-run "POS only vs Full ERP" choice, used when no
//      explicit standalone module list is present.
//   3. CLOUD MODULE gate — the per-company map pushed through /api/sync/pull.
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
  /** Signed SuperAdmin entitlements. Missing means this is a legacy license. */
  licenseModules?: readonly string[];
};

/** Master visibility gate for a Windows screen. */
export function isModuleEnabled(view: WindowsView, opts: GateOpts): boolean {
  // A new standalone license is the complete module authority. This lets a
  // SuperAdmin enable additional ERP modules without requiring local setup.
  if (opts.standalone && opts.licenseModules !== undefined) {
    return opts.licenseModules.includes(moduleForView(view));
  }
  // Legacy profile gate — "pos" hides ERP-only screens.
  if (opts.profile === "pos" && profileForView(view) === "erp") return false;
  // Cloud module gate — cloud mode only.
  if (!opts.standalone) {
    const flags = opts.flags ?? loadWindowsModuleFlags();
    if (!moduleAllowedByCloud(moduleForView(view), flags)) return false;
  }
  return true;
}
