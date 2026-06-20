// Clock-rollback guard (Task #237) — TS side.
//
// THREAT: every license/subscription expiry check compares `expiresAt` to the
// live Windows clock. A cashier who rolls the system clock BACKWARD can extend
// a trial/subscription indefinitely. This guard keeps a monotonic time
// high-water-mark (HWM) and HARD-LOCKS the device the moment it sees the clock
// jump backward past a tolerance, in BOTH cloud and standalone modes.
//
// WHY the logic lives here (not in Rust): unlock-code verification reuses the
// SAME @noble/ed25519 verify path + pinned public key the offline-license
// loader already uses, and the Rust side compiles only in CI. Rust owns just
// ONE thing the webview cannot — a machine-bound ENCRYPTED file (AES-256-GCM,
// "zenc1:", key = SHA256(hardware fingerprint)) exposed via the
// `clock_guard_file_read` / `clock_guard_file_write` commands.
//
// REDUNDANT STORES: the state {hwm, locked, nonce} is mirrored across THREE
// stores — SQLite `app_settings.clock_guard_state`, the encrypted file, and
// (dev only) localStorage — merged by taking MAX(hwm) and OR-ing `locked`, so
// an attacker must defeat every copy at once. Online (cloud) devices are
// additionally anchored to server time, so they cannot be bypassed even by a
// full local wipe. (Documented limitation: a pure-offline standalone device
// whose entire %APPDATA% is wiped AND clock rolled back is out of scope — that
// requires filesystem-level tampering, not just changing the clock.)
//
// UNLOCK (SuperAdmin only):
//   • OFFLINE — cashier reads the on-screen device code, SuperAdmin signs an
//     Ed25519 unlock code bound to fingerprint+nonce, cashier pastes it back.
//   • ONLINE  — one click stamps pos_devices.clock_unblock_at; the device picks
//     it up via /validate or /sync/pull → `clockGuardClearOnline`.

import { invoke, getFingerprint } from "./tauri-shim";
import { verifyWithAcceptedPubkeys } from "./standalone";

const TOLERANCE_MS = 60 * 60 * 1000; // 1h — absorbs DST / NTP nudges / timezone fixes.
const SQLITE_KEY = "clock_guard_state";
const LS_KEY = "pos_desktop_clock_guard_state";
const CONSUMED_SQLITE_KEY = "clock_guard_consumed_unblock";
const CONSUMED_LS_KEY = "pos_desktop_clock_guard_consumed_unblock";

export type GuardState = { hwm: number; locked: boolean; nonce: string };
export type ClockGuardResult = { locked: boolean; deviceCode: string | null; effectiveNow: number };

// ─── MONOTONIC in-session anchor (closes the "careful freeze" bypass) ────
// Comparing the wall clock only against a persisted high-water-mark is not
// enough: an attacker can roll the clock back by ~the elapsed real time on
// every tick, pinning `now` just under the HWM so it never advances and
// `effectiveNow` freezes — pausing the trial countdown indefinitely.
//
// `performance.now()` is a MONOTONIC source unaffected by system-clock changes.
// We anchor (perfAtAnchor, wallAtAnchor) once per session and, on every tick,
// derive monoNow = wallAtAnchor + (performance.now() - perfAtAnchor). This rises
// with REAL elapsed time no matter what the user does to the Windows clock, so
// effectiveNow keeps advancing (trial keeps counting down) and a sustained
// freeze eventually trips the backward-jump lock. The anchor is in-memory only
// (resets each launch); the persisted HWM covers the cross-restart case.
let anchorPerf: number | null = null;
let anchorWall: number | null = null;

function perfNow(): number | null {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  } catch { /* ignore */ }
  return null;
}
function resetMonotonicAnchor(): void { anchorPerf = null; anchorWall = null; }

// ─── tiny byte helpers (mirror standalone.ts, which keeps them private) ──
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function strToB64url(s: string): string {
  return bytesToB64(strToBytes(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s: string): string {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  t += "=".repeat((4 - (t.length % 4)) % 4);
  return atob(t);
}

function parseState(raw: string | null | undefined): GuardState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const hwm = Number(o?.hwm);
    if (!Number.isFinite(hwm) || hwm < 0) return null;
    return { hwm, locked: !!o?.locked, nonce: typeof o?.nonce === "string" ? o.nonce : "" };
  } catch {
    return null;
  }
}

// ─── redundant-store I/O (each backend best-effort; failures ignored) ────
async function readStores(): Promise<GuardState[]> {
  const out: GuardState[] = [];
  try {
    const v = await invoke<string | null>("standalone_get_setting", { key: SQLITE_KEY });
    const s = parseState(v); if (s) out.push(s);
  } catch { /* no Tauri / no row */ }
  try {
    const v = await invoke<string | null>("clock_guard_file_read");
    const s = parseState(v); if (s) out.push(s);
  } catch { /* no Tauri / wrong machine / missing file */ }
  try {
    if (typeof localStorage !== "undefined") {
      const s = parseState(localStorage.getItem(LS_KEY)); if (s) out.push(s);
    }
  } catch { /* ignore */ }
  return out;
}

async function writeStores(s: GuardState): Promise<void> {
  const json = JSON.stringify(s);
  try { await invoke("standalone_set_setting", { key: SQLITE_KEY, value: json }); } catch { /* ignore */ }
  try { await invoke("clock_guard_file_write", { blob: json }); } catch { /* ignore */ }
  try { if (typeof localStorage !== "undefined") localStorage.setItem(LS_KEY, json); } catch { /* ignore */ }
}

function mergeStores(stores: GuardState[]): GuardState {
  let hwm = 0, locked = false, nonce = "";
  for (const s of stores) {
    if (s.hwm > hwm) hwm = s.hwm;
    if (s.locked) { locked = true; if (s.nonce) nonce = s.nonce; }
  }
  return { hwm, locked, nonce };
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function buildDeviceCode(nonce: string): Promise<string> {
  let fp = "BROWSER-DEV";
  try { fp = await getFingerprint(); } catch { /* dev fallback */ }
  return strToB64url(JSON.stringify({ fp, n: nonce, v: 1 }));
}

// ─── consumed-unblock marker (dedupe online clears) ──────────────────────
async function getConsumed(): Promise<number> {
  let v = 0;
  try {
    const s = await invoke<string | null>("standalone_get_setting", { key: CONSUMED_SQLITE_KEY });
    const n = Number(s); if (Number.isFinite(n)) v = Math.max(v, n);
  } catch { /* ignore */ }
  try {
    if (typeof localStorage !== "undefined") {
      const n = Number(localStorage.getItem(CONSUMED_LS_KEY)); if (Number.isFinite(n)) v = Math.max(v, n);
    }
  } catch { /* ignore */ }
  return v;
}
async function setConsumed(ms: number): Promise<void> {
  const val = String(ms);
  try { await invoke("standalone_set_setting", { key: CONSUMED_SQLITE_KEY, value: val }); } catch { /* ignore */ }
  try { if (typeof localStorage !== "undefined") localStorage.setItem(CONSUMED_LS_KEY, val); } catch { /* ignore */ }
}

/**
 * Core guard tick. Run on boot AND on a periodic interval in BOTH boot trees.
 *
 *   - `trustedNowMs` (optional): an authoritative server clock (from /validate
 *     or /sync/pull). Used as a FLOOR for the HWM so an online device cannot be
 *     wound back even by wiping its local stores.
 *
 * Returns `{ locked, deviceCode, effectiveNow }`. `effectiveNow` =
 * max(systemNow, HWM) and MUST be used for every expiry comparison so a
 * rolled-back clock can never extend validity.
 */
export async function clockGuardCheck(opts?: { trustedNowMs?: number }): Promise<ClockGuardResult> {
  const now = Date.now();
  const merged = mergeStores(await readStores());
  let hwm = merged.hwm;
  if (opts?.trustedNowMs && Number.isFinite(opts.trustedNowMs) && opts.trustedNowMs > hwm) {
    hwm = opts.trustedNowMs;
  }

  // Already locked from a previous detection — stay locked until an explicit
  // unlock (offline code or online unblock). Server time does NOT auto-clear.
  if (merged.locked) {
    return { locked: true, deviceCode: await buildDeviceCode(merged.nonce || randomNonce()), effectiveNow: Math.max(now, hwm) };
  }

  // Monotonic floor: rises with REAL elapsed time regardless of the wall clock.
  // (Re)seed the anchor when missing — anchor wall is floored at max(now, hwm)
  // so monoNow can never start below the persisted high-water-mark.
  const p = perfNow();
  if (anchorPerf === null || anchorWall === null || p === null) {
    anchorPerf = p;
    anchorWall = Math.max(now, hwm);
  }
  let monoNow = Math.max(now, hwm);
  if (p !== null && anchorPerf !== null && anchorWall !== null) {
    const elapsed = p - anchorPerf; // monotonic, immune to clock changes
    if (elapsed >= 0) monoNow = Math.max(monoNow, anchorWall + elapsed);
  }

  // Backward-clock detected beyond tolerance → hard-lock with a fresh nonce.
  // Two independent triggers: (a) the clock fell far below the persisted HWM
  // (catches a big rollback across restarts); (b) the clock fell far below the
  // monotonic expectation (catches a sustained in-session freeze — after ~1h of
  // real time a clock pinned in the past trips this).
  const backwardVsHwm = now < hwm - TOLERANCE_MS;
  const backwardVsMono = p !== null && now < monoNow - TOLERANCE_MS;
  if (backwardVsHwm || backwardVsMono) {
    const nonce = randomNonce();
    const lockedHwm = Math.max(hwm, monoNow);
    await writeStores({ hwm: lockedHwm, locked: true, nonce });
    return { locked: true, deviceCode: await buildDeviceCode(nonce), effectiveNow: Math.max(now, lockedHwm) };
  }

  // Healthy tick — advance the high-water-mark by the monotonic floor too, so
  // effectiveNow keeps progressing even if the wall clock is being held still.
  const newHwm = Math.max(hwm, now, monoNow);
  await writeStores({ hwm: newHwm, locked: false, nonce: "" });
  return { locked: false, deviceCode: null, effectiveNow: Math.max(now, newHwm) };
}

/**
 * Verifies a SuperAdmin-signed OFFLINE unlock code (zero internet) against the
 * pinned Ed25519 key, bound to THIS machine's fingerprint and the CURRENT lock
 * nonce, then clears the lock and rebases the HWM to now.
 */
export async function clockGuardUnlockOffline(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = (code || "").trim();
  if (!trimmed) return { ok: false, error: "أدخل رمز فك الحظر" };

  let outer: { p?: string; s?: string };
  try { outer = JSON.parse(b64urlToStr(trimmed)); }
  catch { return { ok: false, error: "رمز غير صالح" }; }
  if (!outer?.p || !outer?.s) return { ok: false, error: "رمز غير صالح" };

  // Verify against the SAME accepted-key set used for offline license files
  // (build-pinned key + any TOFU-trusted key + on-demand server key), NOT only
  // the build-pinned key. Otherwise an MSI shipped with a stale hardcoded pinned
  // key rejects every unlock code the (key-rotated) server signs, even though
  // the device already trusts the real key from license activation.
  let verified = false;
  try {
    verified = await verifyWithAcceptedPubkeys(strToBytes(outer.p), b64ToBytes(outer.s));
  } catch { return { ok: false, error: "فشل التحقق من التوقيع" }; }
  if (!verified) return { ok: false, error: "توقيع غير صحيح — الرمز غير صادر من الجهة المصرّح لها" };

  let payload: { fp?: string; nonce?: string; purpose?: string };
  try { payload = JSON.parse(new TextDecoder().decode(b64ToBytes(outer.p))); }
  catch { return { ok: false, error: "محتوى الرمز غير صالح" }; }
  if (payload?.purpose !== "clock_unlock") return { ok: false, error: "نوع الرمز غير صحيح" };

  let fp = "BROWSER-DEV";
  try { fp = await getFingerprint(); } catch { /* dev */ }
  if (payload.fp !== fp) return { ok: false, error: "هذا الرمز صادر لجهاز آخر" };

  const merged = mergeStores(await readStores());
  if (!merged.locked) { return { ok: true }; } // already unlocked
  if (!merged.nonce || payload.nonce !== merged.nonce) {
    return { ok: false, error: "انتهت صلاحية هذا الرمز — اطلب رمزًا جديدًا بالرمز المعروض حاليًا" };
  }

  await writeStores({ hwm: Date.now(), locked: false, nonce: "" });
  resetMonotonicAnchor(); // rebase the in-session monotonic baseline to now
  return { ok: true };
}

/**
 * ONLINE clear: when /validate or /sync/pull returns a `clockUnblockAt` newer
 * than the last consumed value, clear the lock and rebase the HWM to server
 * time. Returns true when it actually cleared an existing lock.
 */
export async function clockGuardClearOnline(
  serverUnblockAt: string | null | undefined,
  serverTime: string | null | undefined,
): Promise<boolean> {
  if (!serverUnblockAt) return false;
  const unblockMs = new Date(serverUnblockAt).getTime();
  if (!Number.isFinite(unblockMs)) return false;

  const consumed = await getConsumed();
  if (unblockMs <= consumed) return false; // already processed this signal

  await setConsumed(unblockMs); // mark consumed regardless, so we don't re-process

  const merged = mergeStores(await readStores());
  if (!merged.locked) return false;

  const stMs = serverTime ? new Date(serverTime).getTime() : Date.now();
  await writeStores({ hwm: Number.isFinite(stMs) ? stMs : Date.now(), locked: false, nonce: "" });
  resetMonotonicAnchor(); // rebase the in-session monotonic baseline to server time
  return true;
}
