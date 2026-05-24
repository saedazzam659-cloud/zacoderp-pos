// Typed client for the ZACOD cloud APIs consumed by the desktop POS.
// All endpoints here were validated end-to-end in Task #174 (23/23 passing).
//
// Two distinct authentication flows:
//   1. Public:  /api/public/*           — no auth header
//   2. Activation: /api/device-licenses/activate — no auth (license key itself is the credential)
//   3. Device:  everything else         — X-Device-Token header
//
// The desktop app obtains the device token from POST /activate and persists it
// in the OS secure store (see tauri-shim.ts). All subsequent /sync, /validate,
// /deactivate calls send it as `X-Device-Token`.

export type ActivateRequest = {
  licenseKey: string;
  fingerprint: string;
  deviceName: string;
  branchId?: number;
  osInfo?: string;
  appVersion?: string;
};

export type ActivateResponse = {
  deviceId: number;
  deviceToken: string;
  companyId: number;
  companyName: string;
  branchId: number | null;
  expiresAt: string | null;
  message: string;
};

export type ValidateResponse = {
  valid: boolean;
  deviceId: number;
  companyId: number;
  licenseStatus: string | null;
  expiresAt: string | null;
  serverTime: string;
};

export type HeartbeatRequest = {
  appVersion?: string;
  battery?: number;
  osInfo?: string;
};

export type PullRequest = {
  since?: string;
  entities?: Array<"customers" | "items" | "settings">;
};
export type PullResponse = {
  ok: true;
  serverTime: string;
  entities: {
    customers?: Array<{ id: number; nameAr: string; nameEn: string | null; phone: string | null; vatNumber: string | null; createdAt: string }>;
    items?: Array<{ id: number; code: string; nameAr: string; nameEn: string | null; barcode: string | null; salePrice: string; vatRate: string; updatedAt: string }>;
    settings?: Array<{ enableOfflinePos: boolean; serverTime: string }>;
  };
};

export type PushItem = {
  clientId: string;
  entityType: string;
  operation: "create" | "update" | "delete";
  payload: Record<string, unknown>;
  occurredAt?: string;
};
export type PushResponse = {
  ok: true;
  acks: Array<{ clientId: string; status: "queued" | "applied" | "conflict" | "rejected"; note?: string }>;
  serverTime: string;
};

export type SyncStatus = {
  id: number;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  status: string;
  serverTime: string;
};

export type DownloadRelease = {
  id: number;
  countryCode: string;
  platform: string;
  version: string;
  downloadUrl: string;
  fileSizeBytes: number | null;
  checksumSha256: string | null;
  releaseNotes: string | null;
};

// ─── Error type ──────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseError(r: Response): Promise<ApiError> {
  let body: any = null;
  try { body = await r.json(); } catch { body = { error: r.statusText }; }
  return new ApiError(r.status, body?.error ?? "unknown_error", body?.error ?? r.statusText, body);
}

// ─── Client factory ──────────────────────────────────────────────────
// `timeoutMs` defaults to 15s so a hung TCP connection can't leave the UI in
// a permanent "busy" state (e.g. spinner stuck on "جارٍ التفعيل...").
export function createApi(opts: { baseUrl: string; deviceToken?: string | null; timeoutMs?: number }) {
  const base = opts.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.deviceToken) headers["X-Device-Token"] = opts.deviceToken;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...(init?.headers ?? {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        ...init,
      });
      if (!r.ok) throw await parseError(r);
      return r.json() as Promise<T>;
    } catch (e: any) {
      if (e?.name === "AbortError") throw new ApiError(0, "timeout", `انتهت مهلة الاتصال بعد ${timeoutMs / 1000} ثانية`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // ── Public (no auth) ──────────────────────────────────────────────
    publicCountries: () => call<{ code: string; name: string }[]>("GET", "/api/public/download/countries"),
    publicRelease: (country: string, platform = "win-x64") =>
      call<DownloadRelease>("GET", `/api/public/download/release?country=${encodeURIComponent(country)}&platform=${encodeURIComponent(platform)}`),

    // ── Activation (license key is the credential) ────────────────────
    activate: (req: ActivateRequest) =>
      call<ActivateResponse>("POST", "/api/device-licenses/activate", req),

    // ── Device-authenticated (X-Device-Token) ─────────────────────────
    validate: () => call<ValidateResponse>("POST", "/api/device-licenses/validate", {}),
    deactivate: () => call<{ ok: true; message: string }>("POST", "/api/device-licenses/deactivate", {}),
    heartbeat: (req: HeartbeatRequest = {}) =>
      call<{ ok: true; serverTime: string }>("POST", "/api/sync/heartbeat", req),
    pull: (req: PullRequest = {}) => call<PullResponse>("POST", "/api/sync/pull", req),
    push: (items: PushItem[]) => call<PushResponse>("POST", "/api/sync/push", { items }),
    status: () => call<SyncStatus>("GET", "/api/sync/status"),

    // Convenience for the App boot path:
    // Returns the device's recent online status or null if the token is invalid/revoked.
    safeValidate: async (): Promise<ValidateResponse | null> => {
      try { return await call<ValidateResponse>("POST", "/api/device-licenses/validate", {}); }
      catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null; throw e; }
    },
  };
}

export type ApiClient = ReturnType<typeof createApi>;
