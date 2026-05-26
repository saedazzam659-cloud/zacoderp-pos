// Standalone mode infrastructure — Task #199.
//
// "Standalone" means the POS Desktop runs 100% offline against a local SQLite
// database with NO cloud sync, NO heartbeats, NO acting-company, NO sales push.
// Authentication is local: username/password rows in localStorage (later: SQLite
// when Tauri-side helpers land). License is a single Ed25519-signed JSON file
// the SuperAdmin generated on the cloud and the operator dropped into the app.
//
// Two layers gate access:
//   1. License file (loaded once via the activation wizard, persisted)
//   2. Local user credentials (created on first activation, then standard login)
//
// The cloud-mode boot path (Activation → CashierLogin → /api/sync/*) is left
// completely untouched; we just branch at the top of App.tsx on the chosen
// mode and never call cloud helpers in standalone.

import * as ed from "@noble/ed25519";

// ─── App mode ────────────────────────────────────────────────────────
const MODE_KEY = "pos_desktop_app_mode";
export type AppMode = "cloud" | "standalone";

export function getAppMode(): AppMode | null {
  const v = localStorage.getItem(MODE_KEY);
  return v === "cloud" || v === "standalone" ? v : null;
}
export function setAppMode(m: AppMode): void {
  localStorage.setItem(MODE_KEY, m);
}
export function clearAppMode(): void {
  localStorage.removeItem(MODE_KEY);
}

// ─── License file (signed JSON dropped in via wizard) ────────────────
const LICENSE_KEY = "pos_desktop_standalone_license";

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

// The Ed25519 public key that ALL standalone licenses must be signed with.
// Configured at build time via `VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64` so each
// build is pinned to one signing authority. Empty string in dev = accept
// the key embedded in the license file (DEV ONLY — production must pin).
const PINNED_PUBKEY_B64: string = (import.meta.env.VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64 ?? "") as string;
export const DEV_PUBKEY_UNPINNED = !PINNED_PUBKEY_B64;

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
  // Production builds MUST be pinned to a build-time public key. Failing
  // closed here prevents the misconfiguration where a missing build env
  // var silently lets attacker-signed licenses verify against their own
  // embedded key. Dev/preview builds (vite serve) are exempt so the
  // unsigned flow can still be exercised locally.
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
  // Re-check the embedded payload matches the displayed one (defense in depth)
  if (JSON.stringify(payload) !== JSON.stringify(file.payload)) {
    return { ok: false, error: "العرض غير مطابق للمحتوى الموقّع — الملف معدّل" };
  }
  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
    return { ok: false, error: `الترخيص منتهي (انتهى في ${new Date(payload.expiresAt).toLocaleDateString("ar-SA")})` };
  }
  return { ok: true, payload };
}

export function saveLicense(file: SignedLicenseFile): void {
  localStorage.setItem(LICENSE_KEY, JSON.stringify(file));
}
export function loadLicense(): SignedLicenseFile | null {
  try {
    const raw = localStorage.getItem(LICENSE_KEY);
    return raw ? JSON.parse(raw) as SignedLicenseFile : null;
  } catch { return null; }
}
export function clearLicense(): void {
  localStorage.removeItem(LICENSE_KEY);
}

// ─── Local users (single-machine auth, PBKDF2-SHA256) ────────────────
const USERS_KEY = "pos_desktop_standalone_users";
const SESSION_KEY = "pos_desktop_standalone_session";
const PBKDF2_ITERS = 100_000;

export type LocalUserRole = "admin" | "cashier";
export type LocalUser = {
  id: string;
  username: string;
  displayName: string;
  role: LocalUserRole;
  saltB64: string;
  hashB64: string;
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

function loadAllUsers(): LocalUser[] {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) ?? "[]"); }
  catch { return []; }
}
function saveAllUsers(list: LocalUser[]): void {
  localStorage.setItem(USERS_KEY, JSON.stringify(list));
}

async function pbkdf2(password: string, saltBytes: Uint8Array): Promise<Uint8Array> {
  // Cast through `BufferSource` to placate TS lib mismatch between
  // `Uint8Array<ArrayBufferLike>` (lib.es2024+) and `BufferSource` (DOM).
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

export function listLocalUsers(): LocalUser[] {
  return loadAllUsers();
}
export function countLocalUsers(): number {
  return loadAllUsers().length;
}

export async function createLocalUser(input: {
  username: string; displayName: string; password: string; role: LocalUserRole;
}): Promise<LocalUser> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new Error("اسم المستخدم: 3-30 حرفاً، أحرف إنجليزية صغيرة وأرقام و . _ -");
  if (input.password.length < 4) throw new Error("كلمة المرور قصيرة جداً (4 أحرف على الأقل)");
  const users = loadAllUsers();
  if (users.some((u) => u.username === username)) throw new Error("اسم المستخدم موجود مسبقاً");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(input.password, salt);
  const u: LocalUser = {
    id: uuid(),
    username,
    displayName: input.displayName.trim() || username,
    role: input.role,
    saltB64: bytesToB64(salt),
    hashB64: bytesToB64(hash),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  saveAllUsers([...users, u]);
  return u;
}

export async function authLocalUser(username: string, password: string): Promise<LocalSession> {
  const users = loadAllUsers();
  const u = users.find((x) => x.username === username.trim().toLowerCase());
  if (!u) throw new Error("اسم مستخدم أو كلمة مرور غير صحيحة");
  const salt = b64ToBytes(u.saltB64);
  const candidate = await pbkdf2(password, salt);
  const stored = b64ToBytes(u.hashB64);
  // Constant-time compare
  if (candidate.length !== stored.length) throw new Error("اسم مستخدم أو كلمة مرور غير صحيحة");
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate[i] ^ stored[i];
  if (diff !== 0) throw new Error("اسم مستخدم أو كلمة مرور غير صحيحة");
  // Update lastLoginAt
  u.lastLoginAt = new Date().toISOString();
  saveAllUsers(users.map((x) => x.id === u.id ? u : x));
  const session: LocalSession = {
    userId: u.id, username: u.username, displayName: u.displayName, role: u.role,
    signedInAt: new Date().toISOString(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function loadLocalSession(): LocalSession | null {
  try {
    const r = localStorage.getItem(SESSION_KEY);
    if (!r) return null;
    const s = JSON.parse(r) as LocalSession;
    // Re-validate against the local users store. Blocks the simplest forgery
    // (writing a fake session blob for a nonexistent user). Defense in depth
    // only — a local attacker with full LS write access can also create a
    // matching user row; rely on OS-level ACLs (Tauri %APPDATA%) for real
    // tamper-resistance.
    const users = loadAllUsers();
    const u = users.find((x) => x.id === s?.userId);
    if (!u || u.username !== s.username || u.role !== s.role) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}
export function clearLocalSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export async function deleteLocalUser(id: string): Promise<void> {
  saveAllUsers(loadAllUsers().filter((u) => u.id !== id));
}

export async function changeLocalPassword(id: string, newPassword: string): Promise<void> {
  if (newPassword.length < 4) throw new Error("كلمة المرور قصيرة جداً");
  const users = loadAllUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("المستخدم غير موجود");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(newPassword, salt);
  u.saltB64 = bytesToB64(salt); u.hashB64 = bytesToB64(hash);
  saveAllUsers(users.map((x) => x.id === id ? u : x));
}

// ─── Full wipe (used by "switch back to cloud mode") ─────────────────
// Removes EVERY `pos_desktop_*` localStorage key — license, users, session,
// mode, parked carts, cashier context, device token, catalog overlays,
// tombstones, country, fingerprint, etc. Iterates because we don't want a
// future feature to silently survive a mode switch and leak prior-tenant
// data into the new tree.
//
// CAVEAT: the SQLite database (Tauri only) is NOT deleted here — it lives
// under %APPDATA% with OS ACLs. Standalone never wrote any business rows
// to it (no pull, no push, no offline invoices), so this is currently a
// no-op for the standalone path. If standalone ever starts persisting to
// SQLite, also call a Tauri command to drop/recreate the DB file here.
export function wipeStandalone(): void {
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pos_desktop_")) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
  } catch {
    // best-effort fallback to the original targeted wipe
    clearLicense();
    clearLocalSession();
    localStorage.removeItem(USERS_KEY);
    clearAppMode();
  }
}
