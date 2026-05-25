// Abstracts Tauri-specific APIs behind a stable interface so the React UI
// can be developed and tested in a plain browser (Vite dev server, Replit
// preview) before the Rust IPC layer is wired up in Step 8 of Task #174.
//
// Strategy:
//   - When running inside Tauri (`window.__TAURI_INTERNALS__` is present)
//     we forward calls to `@tauri-apps/api/core::invoke()`.
//   - Otherwise we fall back to in-browser stubs:
//       * fingerprint  → a deterministic per-browser hash stored in localStorage
//       * secure store → localStorage (NOT secure, dev only)
//       * device name  → derived from navigator.userAgent
//
// This lets us QA the full activation flow against the real cloud APIs from a
// browser, and ship the Tauri build by changing nothing in the UI — only the
// shim resolves to the real `invoke()` at runtime.

const IS_TAURI =
  typeof window !== "undefined" &&
  // Tauri 2.x exposes this object on window
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// ─── invoke() loader (dynamic — avoids breaking the Vite browser build) ──
let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    // Dynamic import keeps @tauri-apps/api out of the browser-only bundle
    // when running on Vite dev server (where Tauri context doesn't exist).
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}

// ─── Hardware fingerprint ────────────────────────────────────────────
// On Windows (Tauri): combines CPU id + motherboard serial + primary MAC +
//                     Windows install id, then SHA-256 hashes the bundle.
//                     Implemented in src-tauri/src/license.rs::collect_fingerprint.
// In browser (dev):   creates one random UUID per browser profile, persists in
//                     localStorage. Same browser → same fingerprint → same
//                     reactivation behaviour as a real device.
export async function getFingerprint(): Promise<string> {
  if (IS_TAURI) {
    try { return await invoke<string>("get_hardware_fingerprint"); }
    catch (e) { console.warn("Tauri get_hardware_fingerprint failed, falling back to stub", e); }
  }
  const KEY = "pos_desktop_dev_fingerprint";
  let fp = localStorage.getItem(KEY);
  if (!fp) {
    fp = `dev-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, fp);
  }
  return fp;
}

// ─── Device name ─────────────────────────────────────────────────────
// On Windows: COMPUTERNAME env var (e.g. "RECEPTION-PC").
// In browser: hostname or a sensible UA-derived label.
export async function getDeviceName(): Promise<string> {
  if (IS_TAURI) {
    try { return await invoke<string>("get_device_name"); }
    catch { /* fall through */ }
  }
  const host = typeof location !== "undefined" ? location.hostname : "dev";
  return `DEV-${host}-${navigator.platform.replace(/\s+/g, "")}`;
}

// ─── OS info (for telemetry only — non-sensitive) ────────────────────
export async function getOsInfo(): Promise<string> {
  if (IS_TAURI) {
    try { return await invoke<string>("get_os_info"); }
    catch { /* fall through */ }
  }
  return `Browser ${navigator.platform} ${navigator.userAgent.slice(0, 80)}`;
}

// ─── Secure storage for the device token ─────────────────────────────
// On Windows: Windows Credential Manager via the `keyring` Rust crate.
// In browser: localStorage (dev only — clearly insecure, label it as such).
const STORE_KEY = "pos_desktop_device_token";

export async function saveDeviceToken(token: string): Promise<void> {
  if (IS_TAURI) {
    try { await invoke("save_device_token", { token }); return; }
    catch (e) { console.warn("Tauri save_device_token failed, falling back", e); }
  }
  localStorage.setItem(STORE_KEY, token);
}

export async function loadDeviceToken(): Promise<string | null> {
  if (IS_TAURI) {
    try { return await invoke<string | null>("load_device_token"); }
    catch { /* fall through */ }
  }
  return localStorage.getItem(STORE_KEY);
}

export async function clearDeviceToken(): Promise<void> {
  if (IS_TAURI) {
    try { await invoke("clear_device_token"); return; }
    catch { /* fall through */ }
  }
  localStorage.removeItem(STORE_KEY);
}

// ─── Cashier user token (Task #175) ─────────────────────────────────
// Separate slot from the device token. Device identifies the machine and
// lives forever; user token identifies the human operator and rotates on
// every login / logout. Stored in the same secure backend (keyring in
// Tauri, localStorage in browser dev).
const USER_TOKEN_KEY    = "pos_desktop_user_token";
const CASHIER_CTX_KEY   = "pos_desktop_cashier_context";

export async function saveUserToken(token: string): Promise<void> {
  if (IS_TAURI) {
    try { await invoke("save_user_token", { token }); return; }
    catch (e) { console.warn("Tauri save_user_token failed, falling back", e); }
  }
  localStorage.setItem(USER_TOKEN_KEY, token);
}
export async function loadUserToken(): Promise<string | null> {
  if (IS_TAURI) {
    try { return await invoke<string | null>("load_user_token"); }
    catch { /* fall through */ }
  }
  return localStorage.getItem(USER_TOKEN_KEY);
}
export async function clearUserToken(): Promise<void> {
  if (IS_TAURI) {
    try { await invoke("clear_user_token"); return; }
    catch { /* fall through */ }
  }
  localStorage.removeItem(USER_TOKEN_KEY);
}

// Cashier context = everything the UI needs to render the topbar (who, where,
// which terminal, which open POS session). Persisted alongside the token so
// a hard refresh in the middle of a shift restores the same state without an
// extra round-trip. Cleared on logout.
export type CashierContext = {
  userId: number;
  username: string;
  nameAr: string | null;
  companyId: number;
  companyName: string;
  branchId: number | null;
  branchName: string | null;
  posTerminalId: number | null;
  posTerminalName: string | null;
  posSessionId: number;
  openedAt: string;
};

export function saveCashierContext(ctx: CashierContext): void {
  try { localStorage.setItem(CASHIER_CTX_KEY, JSON.stringify(ctx)); } catch { /* quota */ }
}
export function loadCashierContext(): CashierContext | null {
  try {
    const raw = localStorage.getItem(CASHIER_CTX_KEY);
    return raw ? JSON.parse(raw) as CashierContext : null;
  } catch { return null; }
}
export function clearCashierContext(): void {
  try { localStorage.removeItem(CASHIER_CTX_KEY); } catch { /* ignore */ }
}

// ─── App version (read once at boot) ─────────────────────────────────
export async function getAppVersion(): Promise<string> {
  if (IS_TAURI) {
    try {
      const mod = await import(/* @vite-ignore */ "@tauri-apps/api/app");
      return await mod.getVersion();
    } catch { /* fall through */ }
  }
  return "0.1.0-dev";
}

export const TAURI_MODE: "tauri" | "browser-dev" = IS_TAURI ? "tauri" : "browser-dev";
