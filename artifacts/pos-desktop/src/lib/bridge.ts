// Bridge layer (Task #207 — LAN shared database).
//
// A single chokepoint for SHARED-data Tauri commands (catalog, customers,
// invoices, stock, cloud-pull). At runtime it decides, based on the
// device's network role, whether to:
//   • single / host → call the LOCAL Tauri command directly (the host owns
//     the one SQLite file, so it behaves exactly like a standalone device).
//   • client        → forward the call over HTTP to the host device's LAN
//     server (`POST {hostUrl}/lan/invoke`) so every read/write lands on the
//     single shared database. The client owns NO data file.
//
// Device-LOCAL commands (peripherals, scale, keyring, license, parked
// carts, session) must NEVER route through here — they always use the
// local Tauri invoke directly. Only shared-data libs import `bridgeInvoke`.
//
// The role is read once at boot (`initBridge`) and cached so hot paths
// (barcode scan, checkout) don't pay an async settings read each call.
// `refreshBridge()` re-reads after the user changes role in settings.

import { IS_TAURI, tauriInvoke } from "./localStore";
import {
  getNetRole, getLanHostUrl, getLanToken,
  type NetRole,
} from "./standalone";

type BridgeState = {
  role: NetRole;
  hostUrl: string | null;
  token: string | null;
};

let _state: BridgeState = { role: "single", hostUrl: null, token: null };
let _initialized = false;

/** Read role + LAN settings once and cache them. Call at app boot. */
export async function initBridge(): Promise<BridgeState> {
  const [role, hostUrl, token] = await Promise.all([
    getNetRole(),
    getLanHostUrl(),
    getLanToken(),
  ]);
  _state = { role, hostUrl, token };
  _initialized = true;
  return _state;
}

/** Re-read after the user changes the role/pairing in settings. */
export async function refreshBridge(): Promise<BridgeState> {
  return initBridge();
}

export function bridgeReady(): boolean { return _initialized; }
export function getRole(): NetRole { return _state.role; }
export function isClient(): boolean { return _state.role === "client"; }
export function isHost(): boolean { return _state.role === "host"; }
export function isSingle(): boolean { return _state.role === "single"; }
export function getHostUrl(): string | null { return _state.hostUrl; }

/**
 * True when a shared-data lib should funnel a call through the bridge at
 * all (vs. fall back to its browser localStorage path). Clients always
 * use the bridge (they have no local data); Tauri host/single devices use
 * the bridge to reach their local invoke.
 */
export function shouldUseBridge(): boolean {
  return isClient() || IS_TAURI;
}

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

const LAN_FETCH_TIMEOUT_MS = 8000;

async function postToHost<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const hostUrl = _state.hostUrl;
  if (!hostUrl) {
    throw new HostUnavailableError(
      "لم يتم ضبط عنوان الجهاز الرئيسي. افتح الإعدادات وأدخل عنوان الجهاز الرئيسي.",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LAN_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${hostUrl}/lan/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lan-token": _state.token ?? "",
      },
      body: JSON.stringify({ cmd, args }),
      signal: controller.signal,
    });
  } catch (e: any) {
    throw new HostUnavailableError(
      `تعذّر الوصول إلى الجهاز الرئيسي (${hostUrl}). تأكد أن الجهاز الرئيسي يعمل وأنكما على نفس الشبكة.`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new HostUnavailableError(
      "رمز الإقران غير صحيح. تأكد من إدخال نفس رمز الفرع الظاهر على الجهاز الرئيسي.",
    );
  }
  if (!res.ok) {
    let msg = `خطأ من الجهاز الرئيسي (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = String(body.error);
    } catch { /* keep generic */ }
    throw new Error(msg);
  }
  const body = await res.json();
  if (body && body.ok === false) {
    throw new Error(String(body.error ?? "خطأ غير معروف من الجهاز الرئيسي"));
  }
  return (body?.result ?? null) as T;
}

/**
 * Invoke a SHARED-data command. Routes to the host over LAN when this
 * device is a client; otherwise calls the local Tauri command. In the
 * browser preview (no Tauri, not a client) this rejects so the caller's
 * localStorage fallback path runs.
 */
export async function bridgeInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isClient()) {
    return postToHost<T>(cmd, args);
  }
  if (IS_TAURI) {
    return tauriInvoke<T>(cmd, args);
  }
  throw new Error("bridge: no transport (browser preview, not a client)");
}

// ─── Host connectivity probe (client side) ───────────────────────────
export type HostPing = { ok: boolean; name?: string; version?: string };

/** Lightweight reachability check used by the connection-status indicator. */
export async function pingHost(): Promise<HostPing> {
  return pingHostAt(_state.hostUrl, _state.token ?? "");
}

/**
 * Side-effect-FREE reachability probe against an explicit url+token. The
 * settings/wizard "test connection" buttons MUST use this — they should never
 * persist `net_role`/`lan_host_url`/`lan_token` just to run a test, or they'd
 * accidentally flip a saved single/host device into client mode.
 */
export async function pingHostAt(hostUrl: string | null, token: string): Promise<HostPing> {
  if (!hostUrl) return { ok: false };
  const url = hostUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${url}/lan/ping`, {
      method: "GET",
      headers: { "x-lan-token": token },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return { ok: true, name: body?.name, version: body?.version };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll the host's monotonically-increasing change counter. Clients call
 * this on a light interval; when the version increases they refetch the
 * catalog + stock so quantities update near-realtime across devices.
 * Returns null when unreachable.
 */
export async function getChangeVersion(): Promise<number | null> {
  const hostUrl = _state.hostUrl;
  if (!hostUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${hostUrl}/lan/changes`, {
      method: "GET",
      headers: { "x-lan-token": _state.token ?? "" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const v = Number(body?.version);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
