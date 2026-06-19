// Standalone-mode client (Task #199).
//
// In the desktop build all state lives in SQLite via Tauri commands
// declared in `src-tauri/src/standalone.rs` — `app_settings.app_mode`,
// `app_settings.standalone_session`, `local_license`, `local_users`.
// Passwords are bcrypt-hashed (cost 12) by the Rust side.
//
// In the browser-preview build (Vite serve, no Tauri) we fall back to
// localStorage and PBKDF2-SHA256 (100k iters). This path is for dev
// only — production MSI builds always have Tauri.

import * as ed from "@noble/ed25519";

// ─── invoke loader (lazy, same pattern as tauri-shim) ────────────────
let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core");
    _invoke = mod.invoke;
  }
  return (await _invoke!(cmd, args)) as T;
}
function hasTauri(): boolean {
  return typeof window !== "undefined"
    && (("__TAURI_INTERNALS__" in window) || ("__TAURI__" in window));
}

// ─── Types ───────────────────────────────────────────────────────────
export type AppMode = "cloud" | "standalone";

export type OfflineLicensePayload = {
  v: 1;
  licenseKey: string;
  customerName: string;
  vertical: "retail" | "pharmacy" | "restaurant" | "grocery" | string;
  plan: string;
  maxUsers: number;
  fingerprintHash: string | null;
  issuedAt: string;
  expiresAt: string | null;
  serverPubKey: string;
  notes?: string;
  // ─── Online self-registration + remote control (Task #236) ──────────
  // Optional so older admin-issued files stay byte-compatible. Populated
  // when the device self-registers online. `graceDays` = how many days the
  // device may run offline before it must re-validate against the cloud.
  country?: string;
  companyTaxNumber?: string;
  companyCrNumber?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  source?: "admin" | "self_register";
  graceDays?: number;
};
export type SignedLicenseFile = {
  v: 1; alg: "ed25519";
  payloadB64: string;
  signature: string;
  publicKey: string;
  publicKeyFingerprint: string;
  payload: OfflineLicensePayload;
};

export type LocalUserRole = "admin" | "cashier";
export type LocalUser = {
  id: string;
  username: string;
  displayName: string;
  role: LocalUserRole;
  createdAt: string;
  lastLoginAt: string | null;
};
export type LocalSession = {
  userId: string;
  username: string;
  displayName: string;
  role: LocalUserRole;
  signedInAt: string;
};

// ─── License verification (pure crypto, mode-agnostic) ───────────────
// Ed25519 public key for offline license verification.
// Safe to commit: this is the PUBLIC key — the matching private key
// lives only in the server's OFFLINE_LICENSE_PRIVATE_KEY_PEM secret.
// Env var still wins so we can rotate without a code change.
const HARDCODED_PUBKEY_B64 = "DiK15tbTP9t837JvtXwx/cFDzPVjKl45ds8FHb/gC+A=";
// Exported so the clock-rollback guard (`lib/clockGuard.ts`) verifies offline
// unlock codes against the SAME pinned key used for offline license files.
export const PINNED_PUBKEY_B64: string =
  ((import.meta.env.VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64 ?? "") as string).trim()
  || HARDCODED_PUBKEY_B64;
export const DEV_PUBKEY_UNPINNED = !PINNED_PUBKEY_B64;

// Trust-on-first-use override. When the SuperAdmin server rotates
// its offline-license signing key, the hardcoded pubkey above no
// longer matches and every fresh install fails to activate. To
// recover without rebuilding the MSI, the desktop fetches the
// server's CURRENT public key from a public read-only endpoint
// (publishes only the pubkey — never the private key) and accepts
// it ONLY IF the embedded license file's signature actually
// verifies against that fetched key. That proves the server holds
// the matching private key. We then persist the accepted key to
// localStorage so subsequent loads on the same machine work fully
// offline. Public update server is the same one used by Updates.
const LS_TRUSTED_PUBKEY = "pos_desktop_trusted_license_pubkey";
const PUBLIC_KEY_FETCH_URL =
  ((import.meta.env.VITE_UPDATE_SERVER_URL ?? "") as string).trim().replace(/\/+$/, "")
  + "/api/public/download/offline-license-public-key";
const FALLBACK_PUBLIC_KEY_URL = "https://zacoderp.com/api/public/download/offline-license-public-key";

function getTrustedPubkey(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(LS_TRUSTED_PUBKEY);
}
function setTrustedPubkey(b64: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_TRUSTED_PUBKEY, b64);
}
async function fetchServerPubkey(): Promise<string | null> {
  const urls = [
    PUBLIC_KEY_FETCH_URL.startsWith("/api") ? null : PUBLIC_KEY_FETCH_URL,
    FALLBACK_PUBLIC_KEY_URL,
  ].filter(Boolean) as string[];
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "GET" });
      if (!r.ok) continue;
      const text = await r.text();
      if (text.trimStart().startsWith("<")) continue; // SPA fallback
      const data = JSON.parse(text) as { publicKeyB64?: string };
      if (data?.publicKeyB64 && /^[A-Za-z0-9+/=]{40,}$/.test(data.publicKeyB64)) {
        return data.publicKeyB64;
      }
    } catch { /* try next */ }
  }
  return null;
}
// Visible debug badge: first 12 + last 4 chars of the pinned pubkey (or "EMPTY").
// Used by StandaloneActivation to prove which build is running on the device.
export const PINNED_PUBKEY_FINGERPRINT: string = PINNED_PUBKEY_B64
  ? `${PINNED_PUBKEY_B64.slice(0, 12)}…${PINNED_PUBKEY_B64.slice(-4)} (${PINNED_PUBKEY_B64.length} chars)`
  : "EMPTY";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function verifyLicenseFile(file: SignedLicenseFile, nowMs: number = Date.now()): Promise<{ ok: true; payload: OfflineLicensePayload } | { ok: false; error: string }> {
  if (file?.alg !== "ed25519" || !file?.payloadB64 || !file?.signature || !file?.publicKey) {
    return { ok: false, error: "ملف ترخيص غير صالح (تنسيق غير مدعوم)" };
  }
  // Build the set of accepted pubkeys for THIS verification:
  //   1) the build-time pinned key (hardcoded / VITE override)
  //   2) any previously TOFU-accepted key cached in localStorage
  //   3) the server's CURRENT key, fetched on-demand if (1) and (2)
  //      don't match the embedded `file.publicKey`. We only trust it
  //      AFTER the signature has cryptographically verified against
  //      it — that proves the server holds the matching private key.
  const accepted = new Set<string>();
  if (PINNED_PUBKEY_B64) accepted.add(PINNED_PUBKEY_B64);
  const trusted = getTrustedPubkey();
  if (trusted) accepted.add(trusted);

  let matched = accepted.has(file.publicKey);
  let tofuFromServer = false;
  if (!matched) {
    const serverKey = await fetchServerPubkey();
    if (serverKey && serverKey === file.publicKey) {
      matched = true;
      tofuFromServer = true;
    }
  }
  if (!matched) {
    return {
      ok: false,
      error:
        "هذا الترخيص لم يُوقَّع بمفتاح هذه النسخة من التطبيق، ولم نتمكن من التحقق من خادم zacoderp.com. " +
        "تأكد من اتصالك بالإنترنت أو راجع مزود الخدمة.",
    };
  }
  try {
    const ok = await ed.verifyAsync(
      b64ToBytes(file.signature),
      strToBytes(file.payloadB64),
      b64ToBytes(file.publicKey),
    );
    if (!ok) return { ok: false, error: "فشل التحقق من توقيع الترخيص" };
  } catch (e: any) {
    return { ok: false, error: `خطأ تحقق: ${e?.message ?? "غير معروف"}` };
  }
  // Crypto passed. If we got here via the on-demand server fetch,
  // persist the accepted key so the next activation on the same
  // machine works fully offline.
  if (tofuFromServer) setTrustedPubkey(file.publicKey);
  let payload: OfflineLicensePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64ToBytes(file.payloadB64)));
  } catch {
    return { ok: false, error: "تعذّر قراءة محتوى الترخيص" };
  }
  if (JSON.stringify(payload) !== JSON.stringify(file.payload)) {
    return { ok: false, error: "العرض غير مطابق للمحتوى الموقّع — الملف معدّل" };
  }
  // `nowMs` is the clock-guard's effectiveNow = max(systemNow, high-water-mark)
  // so a rolled-back Windows clock can never make an expired license re-pass.
  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < nowMs) {
    return {
      ok: false,
      error:
        `الترخيص منتهي (انتهى في ${new Date(payload.expiresAt).toLocaleDateString("ar-SA")}).\n` +
        `للتجديد تواصل مع م/ كرم عزام — داخل مصر: 01000903159 — خارج مصر: 00201000903159 — واتساب: https://wa.me/201000903159`,
    };
  }
  return { ok: true, payload };
}

// ─── Browser fallback (Vite dev only) — PBKDF2 + localStorage ────────
const LS_MODE = "pos_desktop_app_mode";
const LS_LICENSE = "pos_desktop_standalone_license";
const LS_USERS = "pos_desktop_standalone_users";
const LS_SESSION = "pos_desktop_standalone_session";
const PBKDF2_ITERS = 100_000;

type StoredUser = LocalUser & { saltB64: string; hashB64: string };

async function pbkdf2(password: string, saltBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", strToBytes(password) as BufferSource,
    { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    key, 256,
  );
  return new Uint8Array(bits);
}
function bytesToB64(b: Uint8Array): string {
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function uuid(): string {
  return (crypto.randomUUID?.() ?? `u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
}
function lsLoadUsers(): StoredUser[] {
  try { return JSON.parse(localStorage.getItem(LS_USERS) ?? "[]"); }
  catch { return []; }
}
function lsSaveUsers(list: StoredUser[]): void {
  localStorage.setItem(LS_USERS, JSON.stringify(list));
}
function stripStored(u: StoredUser): LocalUser {
  const { saltB64: _s, hashB64: _h, ...rest } = u; void _s; void _h;
  return rest;
}

// ─── Vertical preset (Task #200) ─────────────────────────────────────
// Three presets that switch UI flavor: catalog labels, optional fields,
// per-vertical reports. "general" is the no-op fallback for new businesses.
export type Vertical =
  | "general" | "grocery" | "pharmacy" | "retail" | "restaurant"
  // New trade verticals (Task — new POS register screen). These render the
  // modern RegisterScreen instead of the classic SalesScreen.
  | "plumbing" | "paints" | "auto_parts" | "auto_workshop" | "mobiles";
const LS_VERTICAL = "pos_desktop_vertical";
const SETTING_VERTICAL = "ui_vertical";

// All recognized verticals — used to validate persisted values on read so a
// stored vertical actually round-trips (the old whitelist silently dropped
// retail/restaurant and would drop every new value too).
const ALL_VERTICALS: readonly Vertical[] = [
  "general", "grocery", "pharmacy", "retail", "restaurant",
  "plumbing", "paints", "auto_parts", "auto_workshop", "mobiles",
];
// Verticals that use the new modern RegisterScreen (instead of SalesScreen).
export const NEW_TRADE_VERTICALS: readonly Vertical[] = [
  "plumbing", "paints", "auto_parts", "auto_workshop", "mobiles",
];
export function usesNewRegisterScreen(v: Vertical | null | undefined): boolean {
  return v != null && NEW_TRADE_VERTICALS.includes(v);
}
function asVertical(v: string | null): Vertical | null {
  return v != null && (ALL_VERTICALS as readonly string[]).includes(v) ? (v as Vertical) : null;
}

export async function getVertical(): Promise<Vertical | null> {
  if (hasTauri()) {
    try {
      const v = await invoke<string | null>("standalone_get_setting", { key: SETTING_VERTICAL });
      return asVertical(v);
    } catch { return null; }
  }
  return asVertical(localStorage.getItem(LS_VERTICAL));
}
export async function setVertical(v: Vertical): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_set_setting", { key: SETTING_VERTICAL, value: v }); return; }
    catch { /* fall through */ }
  }
  localStorage.setItem(LS_VERTICAL, v);
}

// ─── App profile (Task #226 — POS-only vs Full ERP) ──────────────────
// Chosen once at first run, applies to BOTH cloud and standalone modes.
//   "pos" → minimal cash-register screens only.
//   "erp" → every screen (still subject to the cloud module gate + per-user
//           permissions).
// Stored next to the vertical in the generic settings store.
const LS_PROFILE = "pos_desktop_app_profile";
const SETTING_PROFILE = "app_profile";

export async function getAppProfile(): Promise<"pos" | "erp" | null> {
  if (hasTauri()) {
    try {
      const v = await invoke<string | null>("standalone_get_setting", { key: SETTING_PROFILE });
      return v === "pos" || v === "erp" ? v : null;
    } catch { return null; }
  }
  const v = localStorage.getItem(LS_PROFILE);
  return v === "pos" || v === "erp" ? v : null;
}
export async function setAppProfile(p: "pos" | "erp"): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_set_setting", { key: SETTING_PROFILE, value: p }); return; }
    catch { /* fall through */ }
  }
  localStorage.setItem(LS_PROFILE, p);
}

// ─── Mode ────────────────────────────────────────────────────────────
export async function getAppMode(): Promise<AppMode | null> {
  if (hasTauri()) {
    try {
      const v = await invoke<string | null>("standalone_get_mode");
      return v === "cloud" || v === "standalone" ? v : null;
    } catch { return null; }
  }
  const v = localStorage.getItem(LS_MODE);
  return v === "cloud" || v === "standalone" ? v : null;
}
export async function setAppMode(m: AppMode): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_set_mode", { mode: m }); return; } catch { /* fall through */ }
  }
  localStorage.setItem(LS_MODE, m);
}

// ─── Network role (Task #207 — LAN shared database) ──────────────────
// A device's network role is orthogonal to app_mode (cloud/standalone):
//   • single — one device, own SQLite (today's behaviour, the default).
//   • host   — this device sells AND hosts the shared SQLite + a local
//              HTTP server other devices connect to over the branch LAN.
//   • client — sells but owns NO data file; every shared-data read/write
//              is routed to the host over HTTP (see lib/bridge.ts).
// Settings live next to app_mode (app_settings in Tauri, localStorage in
// browser dev). lan_host_url/lan_token are only meaningful for clients;
// lan_port only for the host.
export type NetRole = "single" | "host" | "client";

const SETTING_NET_ROLE = "net_role";
const SETTING_LAN_HOST_URL = "lan_host_url";
const SETTING_LAN_TOKEN = "lan_token";
const SETTING_LAN_PORT = "lan_port";

const LS_NET_ROLE = "pos_desktop_net_role";
const LS_LAN_HOST_URL = "pos_desktop_lan_host_url";
const LS_LAN_TOKEN = "pos_desktop_lan_token";
const LS_LAN_PORT = "pos_desktop_lan_port";

/** Default LAN port for the host server. Kept in sync with lan.rs. */
export const DEFAULT_LAN_PORT = 7711;

async function getSetting(key: string, ls: string): Promise<string | null> {
  if (hasTauri()) {
    try { return await invoke<string | null>("standalone_get_setting", { key }); }
    catch { return null; }
  }
  return localStorage.getItem(ls);
}
async function setSetting(key: string, ls: string, value: string): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_set_setting", { key, value }); return; }
    catch { /* fall through */ }
  }
  localStorage.setItem(ls, value);
}

export async function getNetRole(): Promise<NetRole> {
  const v = await getSetting(SETTING_NET_ROLE, LS_NET_ROLE);
  return v === "host" || v === "client" ? v : "single";
}
export async function setNetRole(role: NetRole): Promise<void> {
  await setSetting(SETTING_NET_ROLE, LS_NET_ROLE, role);
}
export async function getLanHostUrl(): Promise<string | null> {
  const v = await getSetting(SETTING_LAN_HOST_URL, LS_LAN_HOST_URL);
  return v && v.trim() ? v.trim().replace(/\/+$/, "") : null;
}
export async function setLanHostUrl(url: string): Promise<void> {
  await setSetting(SETTING_LAN_HOST_URL, LS_LAN_HOST_URL, url.trim().replace(/\/+$/, ""));
}
export async function getLanToken(): Promise<string | null> {
  const v = await getSetting(SETTING_LAN_TOKEN, LS_LAN_TOKEN);
  return v && v.trim() ? v.trim() : null;
}
export async function setLanToken(token: string): Promise<void> {
  await setSetting(SETTING_LAN_TOKEN, LS_LAN_TOKEN, token.trim());
}
export async function getLanPort(): Promise<number> {
  const v = await getSetting(SETTING_LAN_PORT, LS_LAN_PORT);
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_LAN_PORT;
}
export async function setLanPort(port: number): Promise<void> {
  await setSetting(SETTING_LAN_PORT, LS_LAN_PORT, String(port));
}

/** Generate a branch pairing token (host side). 32 hex chars. */
export function generateLanToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── License ─────────────────────────────────────────────────────────
export async function saveLicense(file: SignedLicenseFile): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_save_license", { fileJson: JSON.stringify(file) }); return; } catch { /* fall through */ }
  }
  localStorage.setItem(LS_LICENSE, JSON.stringify(file));
}
export async function loadLicense(): Promise<SignedLicenseFile | null> {
  if (hasTauri()) {
    try {
      const raw = await invoke<string | null>("standalone_load_license");
      return raw ? JSON.parse(raw) as SignedLicenseFile : null;
    } catch { return null; }
  }
  try {
    const raw = localStorage.getItem(LS_LICENSE);
    return raw ? JSON.parse(raw) as SignedLicenseFile : null;
  } catch { return null; }
}

// ─── Online self-registration + remote revalidation (Task #236) ──────
// Standalone devices can register their company profile with the cloud and
// then periodically re-validate over the internet. The cloud SuperAdmin
// controls expiry/renewal/revocation centrally; a device that cannot reach
// the cloud for STANDALONE_GRACE_DAYS locks until it re-validates.
//
// Persisted in the SAME generic settings store as net_role etc. — no Rust
// change is needed. `last_license_check` is the epoch-ms of the last
// SUCCESSFUL online revalidation (or initial register).
export const STANDALONE_GRACE_DAYS = 7;

const SETTING_LAST_LICENSE_CHECK = "last_license_check";
const LS_LAST_LICENSE_CHECK = "pos_desktop_last_license_check";

const REGISTER_BASE: string =
  (((import.meta.env.VITE_UPDATE_SERVER_URL ?? "") as string).trim().replace(/\/+$/, ""))
  || "https://zacoderp.com";

export async function getLastLicenseCheck(): Promise<number | null> {
  const v = await getSetting(SETTING_LAST_LICENSE_CHECK, LS_LAST_LICENSE_CHECK);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
export async function setLastLicenseCheck(ts: number): Promise<void> {
  await setSetting(SETTING_LAST_LICENSE_CHECK, LS_LAST_LICENSE_CHECK, String(ts));
}

/**
 * Has the offline grace window elapsed since the last successful online check?
 *
 * `lastCheck` is the epoch-ms of the last SUCCESSFUL revalidation. When it is
 * null (e.g. a self-register license file imported by hand, or storage reset
 * before the first online check) the caller MUST pass a trusted `fallbackTs`
 * — typically the license's `issuedAt` — so the grace window is anchored to a
 * real point in time. Without a fallback we conservatively report expired,
 * because a self-register license that can prove no check-in time must not run
 * indefinitely offline. (Admin-issued FILE licenses never call this — they are
 * gated out by `source !== 'self_register'` before we reach here, Task #233.)
 */
export function isGraceExpired(
  lastCheck: number | null,
  graceDays = STANDALONE_GRACE_DAYS,
  fallbackTs?: number | null,
  // Pass the clock-guard's effectiveNow (= max(systemNow, monotonic HWM)) so a
  // rolled-back Windows clock cannot stretch the offline grace window. Defaults
  // to Date.now() only for callers outside the guarded boot tree.
  effectiveNowMs?: number,
): boolean {
  const baseline = lastCheck ?? (Number.isFinite(fallbackTs) && (fallbackTs as number) > 0 ? (fallbackTs as number) : null);
  if (!baseline) return true;
  const days = Number.isFinite(graceDays) && graceDays > 0 ? graceDays : STANDALONE_GRACE_DAYS;
  const nowMs = Number.isFinite(effectiveNowMs) && (effectiveNowMs as number) > 0 ? (effectiveNowMs as number) : Date.now();
  return nowMs - baseline > days * 24 * 60 * 60 * 1000;
}

export type StandaloneCompanyInfo = {
  customerName: string;
  vertical: "retail" | "pharmacy" | "restaurant" | "grocery";
  country?: string;
  companyTaxNumber?: string;
  companyCrNumber?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
};

/**
 * Self-register the company with the cloud and receive a signed license file.
 * Pass the RAW machine fingerprint (the server hashes it). Network failures
 * and non-2xx responses are returned as `{ ok: false }` rather than thrown.
 */
export async function registerStandalone(
  info: StandaloneCompanyInfo,
  fingerprint: string,
): Promise<
  | { ok: true; status: "active"; signedFile: SignedLicenseFile }
  | { ok: true; status: "pending"; licenseKey: string }
  | { ok: false; error: string }
> {
  let body: string;
  try {
    body = JSON.stringify({ ...info, fingerprint, appVersion: __APP_VERSION__ });
  } catch {
    return { ok: false, error: "تعذّر تجهيز بيانات التسجيل" };
  }
  try {
    const r = await fetch(`${REGISTER_BASE}/api/public/offline/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await r.text();
    if (text.trimStart().startsWith("<")) {
      return { ok: false, error: "تعذّر الوصول لخادم التسجيل (استجابة غير متوقعة)." };
    }
    let data: any;
    try { data = JSON.parse(text); } catch { return { ok: false, error: "استجابة غير صالحة من الخادم." }; }
    if (!r.ok) {
      return { ok: false, error: typeof data?.error === "string" ? data.error : `فشل التسجيل (${r.status}).` };
    }
    // NEW flow: a fresh self-registration is created PENDING — the server returns
    // a licenseKey but NO signed file until a SuperAdmin approves it.
    if (data?.status === "pending") {
      const licenseKey = typeof data?.licenseKey === "string" ? data.licenseKey : "";
      if (!licenseKey) return { ok: false, error: "لم يُرجِع الخادم مفتاح ترخيص صالحاً." };
      return { ok: true, status: "pending", licenseKey };
    }
    const signedFile = (data?.signedFile ?? data) as SignedLicenseFile;
    if (!signedFile?.payload || !signedFile?.signature) {
      return { ok: false, error: "لم يُرجِع الخادم ملف ترخيص صالحاً." };
    }
    return { ok: true, status: "active", signedFile };
  } catch (e: any) {
    return { ok: false, error: "تعذّر الاتصال بخادم التسجيل. تأكد من اتصالك بالإنترنت." };
  }
}

// ─── Pending-approval persistence ────────────────────────────────────
// When a device self-registers it gets a licenseKey but must wait for the
// SuperAdmin to approve it. We persist that key (same generic settings store)
// so closing + reopening the app resumes the "awaiting approval" wait instead
// of losing the request. Cleared once the approved + signed file is saved.
const SETTING_PENDING_LICENSE = "pending_license_key";
const LS_PENDING_LICENSE = "pos_desktop_pending_license_key";

export async function getPendingLicenseKey(): Promise<string | null> {
  const v = await getSetting(SETTING_PENDING_LICENSE, LS_PENDING_LICENSE);
  const k = (v ?? "").trim();
  return k.length > 0 ? k : null;
}
export async function setPendingLicenseKey(licenseKey: string): Promise<void> {
  await setSetting(SETTING_PENDING_LICENSE, LS_PENDING_LICENSE, licenseKey.trim());
}
export async function clearPendingLicenseKey(): Promise<void> {
  // Tauri settings store has no delete — overwrite with "" (treated as null on read).
  await setSetting(SETTING_PENDING_LICENSE, LS_PENDING_LICENSE, "");
  if (typeof window !== "undefined") {
    try { localStorage.removeItem(LS_PENDING_LICENSE); } catch { /* ignore */ }
  }
}

export type RevalidateOutcome =
  | { reachable: true; status: "active" | "expired" | "revoked" | "not_found" | "fingerprint_mismatch" | "pending"; signedFile?: SignedLicenseFile }
  | { reachable: false };

/**
 * Re-validate an existing license against the cloud. Used both at boot and on
 * a periodic timer. `reachable:false` means a network/transport failure (the
 * caller falls back to the offline grace window); any other result is an
 * authoritative server verdict.
 */
export async function revalidateLicense(licenseKey: string, fingerprint: string): Promise<RevalidateOutcome> {
  let body: string;
  try {
    body = JSON.stringify({ licenseKey, fingerprint, appVersion: __APP_VERSION__ });
  } catch {
    return { reachable: false };
  }
  try {
    const r = await fetch(`${REGISTER_BASE}/api/public/offline/revalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await r.text();
    if (text.trimStart().startsWith("<")) return { reachable: false };
    let data: any;
    try { data = JSON.parse(text); } catch { return { reachable: false }; }
    if (r.status === 404) return { reachable: true, status: "not_found" };
    if (r.status === 409) return { reachable: true, status: "fingerprint_mismatch" };
    if (!r.ok && r.status >= 500) return { reachable: false };
    const status = data?.status;
    if (status === "pending") {
      return { reachable: true, status: "pending" };
    }
    if (status === "active" || status === "expired" || status === "revoked") {
      return { reachable: true, status, signedFile: data?.signedFile as SignedLicenseFile | undefined };
    }
    return { reachable: false };
  } catch {
    return { reachable: false };
  }
}

// ─── Users ───────────────────────────────────────────────────────────
export async function listLocalUsers(): Promise<LocalUser[]> {
  if (hasTauri()) {
    try { return await invoke<LocalUser[]>("standalone_list_users"); } catch { return []; }
  }
  return lsLoadUsers().map(stripStored);
}
export async function countLocalUsers(): Promise<number> {
  return (await listLocalUsers()).length;
}
export async function createLocalUser(input: {
  username: string; displayName: string; password: string; role: LocalUserRole;
}): Promise<LocalUser> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new Error("اسم المستخدم: 3-30 حرفاً، أحرف إنجليزية صغيرة وأرقام و . _ -");
  if (input.password.length < 4) throw new Error("كلمة المرور قصيرة جداً (4 أحرف على الأقل)");
  const displayName = input.displayName.trim() || username;
  if (hasTauri()) {
    return await invoke<LocalUser>("standalone_create_user", {
      id: uuid(), username, displayName,
      password: input.password, role: input.role,
    });
  }
  const users = lsLoadUsers();
  if (users.some((u) => u.username === username)) throw new Error("اسم المستخدم موجود مسبقاً");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(input.password, salt);
  const u: StoredUser = {
    id: uuid(), username, displayName, role: input.role,
    saltB64: bytesToB64(salt), hashB64: bytesToB64(hash),
    createdAt: new Date().toISOString(), lastLoginAt: null,
  };
  lsSaveUsers([...users, u]);
  return stripStored(u);
}
/**
 * Verify supervisor (admin) credentials WITHOUT mutating the active cashier
 * session. Used by the pharmacy expired-sale override in SalesScreen so the
 * cashier remains signed in after authorization. Browser-preview fallback
 * mirrors the Tauri command using the same PBKDF2 hash store.
 *
 * Returns false on any negative outcome (no such user, wrong password,
 * non-admin role) without leaking which one failed.
 */
export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  const uname = username.trim().toLowerCase();
  if (!uname || !password) return false;
  if (hasTauri()) {
    try { return await invoke<boolean>("standalone_verify_admin", { username: uname, password }); }
    catch { return false; }
  }
  // Browser-preview fallback — PBKDF2 verify against LS user store.
  try {
    const users = lsLoadUsers();
    const u = users.find((x) => x.username === uname);
    if (!u || u.role !== "admin") return false;
    const candidate = await pbkdf2(password, b64ToBytes(u.saltB64));
    const stored = b64ToBytes(u.hashB64);
    if (candidate.length !== stored.length) return false;
    let diff = 0;
    for (let i = 0; i < candidate.length; i++) diff |= candidate[i] ^ stored[i];
    return diff === 0;
  } catch { return false; }
}

export async function authLocalUser(username: string, password: string): Promise<LocalSession> {
  if (hasTauri()) {
    return await invoke<LocalSession>("standalone_auth_user", { username, password });
  }
  const users = lsLoadUsers();
  const u = users.find((x) => x.username === username.trim().toLowerCase());
  if (!u) throw new Error("اسم مستخدم أو كلمة مرور غير صحيحة");
  const candidate = await pbkdf2(password, b64ToBytes(u.saltB64));
  const stored = b64ToBytes(u.hashB64);
  if (candidate.length !== stored.length) throw new Error("اسم مستخدم أو كلمة مرور غير صحيحة");
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate[i] ^ stored[i];
  if (diff !== 0) throw new Error("اسم مستخدم أو كلمة مرور غير صحيحة");
  u.lastLoginAt = new Date().toISOString();
  lsSaveUsers(users.map((x) => x.id === u.id ? u : x));
  const session: LocalSession = {
    userId: u.id, username: u.username, displayName: u.displayName, role: u.role,
    signedInAt: new Date().toISOString(),
  };
  localStorage.setItem(LS_SESSION, JSON.stringify(session));
  return session;
}
export async function loadLocalSession(): Promise<LocalSession | null> {
  if (hasTauri()) {
    try { return await invoke<LocalSession | null>("standalone_load_session"); } catch { return null; }
  }
  try {
    const r = localStorage.getItem(LS_SESSION);
    if (!r) return null;
    const s = JSON.parse(r) as LocalSession;
    const users = lsLoadUsers();
    const u = users.find((x) => x.id === s?.userId);
    if (!u || u.username !== s.username || u.role !== s.role) {
      localStorage.removeItem(LS_SESSION);
      return null;
    }
    return s;
  } catch { return null; }
}
export async function clearLocalSession(): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_clear_session"); return; } catch { /* fall through */ }
  }
  localStorage.removeItem(LS_SESSION);
}
export async function deleteLocalUser(id: string): Promise<void> {
  if (hasTauri()) {
    await invoke("standalone_delete_user", { id });
    return;
  }
  lsSaveUsers(lsLoadUsers().filter((u) => u.id !== id));
}
export async function changeLocalPassword(id: string, newPassword: string): Promise<void> {
  if (newPassword.length < 4) throw new Error("كلمة المرور قصيرة جداً");
  if (hasTauri()) {
    await invoke("standalone_change_password", { id, newPassword });
    return;
  }
  const users = lsLoadUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("المستخدم غير موجود");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(newPassword, salt);
  u.saltB64 = bytesToB64(salt); u.hashB64 = bytesToB64(hash);
  lsSaveUsers(users.map((x) => x.id === id ? u : x));
}

// ─── Full wipe (used when switching modes / deactivating) ────────────
// Tauri path: drops EVERY standalone+catalog row via standalone_wipe_all.
// Browser path: clears every `pos_desktop_*` localStorage key.
export async function wipeStandalone(): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_wipe_all"); } catch { /* best effort */ }
  }
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pos_desktop_")) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
