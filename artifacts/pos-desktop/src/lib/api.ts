// Typed client for the ZACOD cloud APIs consumed by the desktop POS.
//
// Three distinct authentication flows now coexist:
//   1. Public:     /api/public/*              — no auth header
//   2. Activation: /api/device-licenses/activate — no auth (license key IS the credential)
//   3. Device:     /api/sync/*, /api/device-licenses/{validate,deactivate}
//                  — `X-Device-Token` header (Task #174)
//   4. Cashier:    /api/auth/*, /api/pos-*, /api/org/branches
//                  — `Authorization: Bearer <userToken>` (Task #175)
//
// Activation establishes the device identity (one per machine, signed by SuperAdmin
// license). Cashier login establishes the operator identity (one per shift, signed
// by the company's user roster). Both tokens may be present at the same time; the
// device token never expires until revocation, while the cashier token rotates on
// every logout/login.

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
    settings?: Array<{ enableOfflinePos: boolean; serverTime: string; windowsModules?: Record<string, boolean>; renewalMessage?: string }>;
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

// ─── Cashier auth (Task #175) ───────────────────────────────────────
export type CashierLoginRequest = {
  username: string;
  password: string;
  companyCode: string;
};

export type CashierUser = {
  id: number;
  username: string;
  email: string | null;
  role: string;
  companyId: number | null;
  nameAr: string | null;
  nameEn: string | null;
  branchIds: number[];
  viewAllBranches: boolean;
  company: { id: number; name: string; code: string } | null;
};

export type CashierLoginResponse = {
  token: string;
  sessionId: string;
  user: CashierUser;
};

export type Branch = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  regionId: number | null;
  isActive: boolean;
};

export type PosTerminal = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  branchId: number;
  branchName: string | null;
  cashBoxId: number | null;
  cashBoxName: string | null;
  isActive: boolean;
  busyUserId: number | null;
};

export type PosSession = {
  id: number;
  companyId: number;
  userId: number;
  branchId: number | null;
  cashBoxId: number | null;
  posTerminalId: number | null;
  openingCash: string;
  status: "open" | "closed" | "force_closed";
  openedAt: string;
  closedAt: string | null;
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
export function createApi(opts: {
  baseUrl: string;
  deviceToken?: string | null;
  userToken?: string | null;
  timeoutMs?: number;
}) {
  const base = opts.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.deviceToken) headers["X-Device-Token"] = opts.deviceToken;
  if (opts.userToken)   headers["Authorization"]  = `Bearer ${opts.userToken}`;
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
      // Some endpoints (DELETE) may return empty bodies; guard against that.
      const text = await r.text();
      return (text ? JSON.parse(text) : ({} as any)) as T;
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

    // ── Activation ───────────────────────────────────────────────────
    activate: (req: ActivateRequest) =>
      call<ActivateResponse>("POST", "/api/device-licenses/activate", req),

    // ── Device-authenticated ─────────────────────────────────────────
    validate: () => call<ValidateResponse>("POST", "/api/device-licenses/validate", {}),
    deactivate: () => call<{ ok: true; message: string }>("POST", "/api/device-licenses/deactivate", {}),
    heartbeat: (req: HeartbeatRequest = {}) =>
      call<{ ok: true; serverTime: string }>("POST", "/api/sync/heartbeat", req),
    pull: (req: PullRequest = {}) => call<PullResponse>("POST", "/api/sync/pull", req),
    push: (items: PushItem[]) => call<PushResponse>("POST", "/api/sync/push", { items }),
    status: () => call<SyncStatus>("GET", "/api/sync/status"),

    safeValidate: async (): Promise<ValidateResponse | null> => {
      try { return await call<ValidateResponse>("POST", "/api/device-licenses/validate", {}); }
      catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null; throw e; }
    },

    // ── Cashier-authenticated (Bearer userToken) ─────────────────────
    cashierLogin: (req: CashierLoginRequest) =>
      call<CashierLoginResponse>("POST", "/api/auth/login", req),
    cashierLogout: () =>
      call<{ ok: true }>("POST", "/api/auth/logout", {}),
    // /api/auth/me returns the user fields directly at top level (not wrapped).
    cashierMe: () => call<CashierUser>("GET", "/api/auth/me"),

    listBranches: (onlyUserBranches = true) =>
      call<Branch[]>("GET", `/api/org/branches?onlyUserBranches=${onlyUserBranches ? 1 : 0}`),
    listTerminals: (branchId?: number) =>
      call<PosTerminal[]>("GET", `/api/pos-terminals${branchId ? `?branchId=${branchId}&activeOnly=1` : "?activeOnly=1"}`),

    getCurrentPosSession: () =>
      call<PosSession | null>("GET", "/api/pos-sessions/current"),
    openPosSession: (req: {
      branchId?: number;
      cashBoxId?: number;
      openingCash?: number;
      device?: string;
      posTerminalId?: number;
      machineCode?: string;
    }) => call<PosSession>("POST", "/api/pos-sessions/open", req),
    closePosSession: (id: number, body: { closingCash?: number; notes?: string } = {}) =>
      call<PosSession>("POST", `/api/pos-sessions/${id}/close`, body),
    // Device-token authed close used by the offline-retry queue. See
    // pendingSessionCloses.ts for the queue logic and routes/pos-desktop-sync.ts
    // for the server-side handler. Idempotent on the server (already-closed →
    // { ok: true, alreadyClosed: true }), so callers can safely drop the
    // queued op on any 2xx response.
    deferredClosePosSession: (req: { posSessionId: number; closingCash?: number; notes?: string; closedAt?: string }) =>
      call<{ ok: true; alreadyClosed?: boolean; session: PosSession }>("POST", "/api/sync/close-pos-session", req),
  };
}

export type ApiClient = ReturnType<typeof createApi>;
