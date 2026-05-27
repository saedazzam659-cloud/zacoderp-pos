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
const PINNED_PUBKEY_B64: string =
  ((import.meta.env.VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64 ?? "") as string).trim()
  || HARDCODED_PUBKEY_B64;
export const DEV_PUBKEY_UNPINNED = !PINNED_PUBKEY_B64;
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

export async function verifyLicenseFile(file: SignedLicenseFile): Promise<{ ok: true; payload: OfflineLicensePayload } | { ok: false; error: string }> {
  if (file?.alg !== "ed25519" || !file?.payloadB64 || !file?.signature || !file?.publicKey) {
    return { ok: false, error: "ملف ترخيص غير صالح (تنسيق غير مدعوم)" };
  }
  if (!PINNED_PUBKEY_B64) {
    if (import.meta.env.PROD) {
      return { ok: false, error: "هذه النسخة من التطبيق غير مُهيّأة (مفتاح الترخيص العام مفقود في البناء)" };
    }
  } else if (file.publicKey !== PINNED_PUBKEY_B64) {
    return { ok: false, error: "هذا الترخيص لم يُوقَّع بمفتاح هذه النسخة من التطبيق" };
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
  let payload: OfflineLicensePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64ToBytes(file.payloadB64)));
  } catch {
    return { ok: false, error: "تعذّر قراءة محتوى الترخيص" };
  }
  if (JSON.stringify(payload) !== JSON.stringify(file.payload)) {
    return { ok: false, error: "العرض غير مطابق للمحتوى الموقّع — الملف معدّل" };
  }
  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
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
export type Vertical = "general" | "grocery" | "pharmacy";
const LS_VERTICAL = "pos_desktop_vertical";
const SETTING_VERTICAL = "ui_vertical";

export async function getVertical(): Promise<Vertical | null> {
  if (hasTauri()) {
    try {
      const v = await invoke<string | null>("standalone_get_setting", { key: SETTING_VERTICAL });
      return v === "general" || v === "grocery" || v === "pharmacy" ? v : null;
    } catch { return null; }
  }
  const v = localStorage.getItem(LS_VERTICAL);
  return v === "general" || v === "grocery" || v === "pharmacy" ? v : null;
}
export async function setVertical(v: Vertical): Promise<void> {
  if (hasTauri()) {
    try { await invoke("standalone_set_setting", { key: SETTING_VERTICAL, value: v }); return; }
    catch { /* fall through */ }
  }
  localStorage.setItem(LS_VERTICAL, v);
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
