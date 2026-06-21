import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { setAuthTokenGetter, setSessionIdGetter, setActingCompanyIdGetter } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { emitCall } from "@/lib/callSignal";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Register auth token getter for the generated API client so all hooks automatically include Bearer token
setAuthTokenGetter(() => localStorage.getItem("zatca_token"));
// Register a manual-session header so every generated API call carries the
// user's currently-selected session id. Server only honours it when it matches
// the persisted users.current_session_id, so a stale localStorage value is
// silently ignored — invariant lives in middleware/auth.ts (extractAuth).
setSessionIdGetter(() => {
  const v = localStorage.getItem("zatca_manual_session_id");
  return v ? v : null;
});
// SuperAdmin-only "Acting As Company" header — server's resolveCompanyId
// honours `x-acting-company-id` only when the caller's role is superadmin,
// so this is a safe default to attach to every request. A tampered value
// from a tenant user is silently ignored.
// Per-realm override: when the URL hash contains `#__actAs=<number>` (used
// by the audit-log "open in popup" flow so a SuperAdmin can drill into a
// tenant page without polluting their own session, localStorage, or React
// state), the hash wins for THIS JS realm only.
//
// We pin the resolved value in a module-level variable. Each browsing
// context (top window AND each iframe) gets its own copy of this module
// and therefore its own pin — so an iframe running with `#__actAs=42`
// resolves to company 42 while the parent SA window (same tab, same
// origin) keeps resolving to whatever its own localStorage says, with
// zero cross-talk. We deliberately avoid sessionStorage here because it
// IS shared between an iframe and its same-origin parent, which would
// leak the override.
let pinnedActingCompanyForRealm: number | null = null;
function readActingCompanyHashOverride(): number | null {
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/__actAs=(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!(Number.isFinite(n) && n > 0)) return null;
  // Pin for the lifetime of this realm — survives the first wouter
  // navigation that strips the hash.
  pinnedActingCompanyForRealm = n;
  return n;
}
function readActingCompanyFromRealm(): number | null {
  if (pinnedActingCompanyForRealm != null) return pinnedActingCompanyForRealm;
  return readActingCompanyHashOverride();
}
setActingCompanyIdGetter(() => {
  const realmOverride = readActingCompanyFromRealm();
  if (realmOverride != null) return realmOverride;
  const v = localStorage.getItem("zatca_acting_company_id");
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
});

export interface AuthUser {
  id: number;
  username: string;
  email?: string | null;
  role: string;
  companyId?: number | null;
  sessionId?: string | null;
  /**
   * When true, the user can see data from every branch in the company.
   * When false, they are restricted to the branches in `branchIds`.
   * `admin` and `superadmin` always behave as if this were true (server-enforced).
   */
  viewAllBranches?: boolean;
  /** Branches this user is explicitly linked to (used when viewAllBranches=false). */
  branchIds?: number[];
  /**
   * Per-SuperAdmin opt-in for the maintenance critical-digest email.
   * Defaults to true on the server when the column is null. Only meaningful
   * for users with role='superadmin'; other roles are never on the recipient list.
   */
  notifyMaintenanceEmail?: boolean;
  /**
   * Per-SuperAdmin severity threshold for the same digest. Combined with the
   * opt-in above (`notifyMaintenanceEmail` false suppresses everything).
   *   - "critical": receive only when at least one critical finding exists (default).
   *   - "warning":  receive when warnings or criticals exist.
   *   - "all":      receive on any non-OK signal, including silently-broken tools.
   */
  notifyMaintenanceSeverity?: "critical" | "warning" | "all";
  company?: any;
  subscription?: any;
  /**
   * Durable per-user UI preferences, namespaced by screen slug. Mirrors what
   * used to live only in localStorage so a saved grid layout survives a browser
   * cache wipe. Shape: { "<screenSlug>": { ...arbitrary layout blob } }.
   * Written via PUT /api/auth/me/ui-prefs (see saveUiPrefs in lib/uiPrefsApi).
   */
  uiPreferences?: Record<string, any>;
}

/**
 * Lightweight summary of a manual (admin-managed) session the user can pick.
 * Returned by /api/auth/login and /api/sessions/me. The server treats only
 * `active` ones as selectable.
 */
export interface ManualSessionSummary {
  id: number;
  name: string;
  status: string;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string, companyCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  setUser: React.Dispatch<React.SetStateAction<AuthUser | null>>;
  /**
   * SuperAdmin "act as company" — when set, every API call sends an
   * `x-acting-company-id` header that the server treats as the effective
   * tenant for that request. Pass `null` to exit impersonation. Honoured
   * server-side only when the caller's role is superadmin.
   */
  actingCompanyId: number | null;
  setActingCompany: (companyId: number | null) => void;
  /**
   * Used by alternate sign-in flows (e.g. SuperAdmin multi-factor flow,
   * recovery-code/recovery-link flows) to install a session that the
   * client obtained out-of-band from a non-`/api/auth/login` endpoint.
   */
  setSession: (args: { token: string; sessionId?: string | null; user: AuthUser }) => void;
  isAuthenticated: boolean;
  // ── Manual sessions (separate from the per-login work_sessions log) ──
  /** All active sessions the user is assigned to. */
  manualSessions: ManualSessionSummary[];
  /** Currently-selected session id (mirrors localStorage + users.current_session_id). */
  currentSessionId: number | null;
  /** Persist a new selection (or null to clear). Validated server-side. */
  selectManualSession: (sessionId: number | null) => Promise<void>;
  /** Quick-create a session for self (perm-gated server-side). */
  quickCreateManualSession: (name: string) => Promise<void>;
  /** Refresh the assigned-sessions list from /api/sessions/me. */
  refreshManualSessions: () => Promise<void>;
}

export interface RegisterData {
  nameAr: string; nameEn?: string;
  vatNumber: string; crNumber: string;
  city?: string; district?: string; street?: string;
  buildingNumber?: string; postalCode?: string; country?: string;
  phone?: string;
  currency?: string;
  industryName?: string; invoiceType?: string;
  // Multi-industry classification (commercial / industrial / contracting /
  // medical / hotels). Persisted as a comma-joined list on companies.industryName.
  selectedIndustries?: string[];
  // High-level system module keys (sales / purchasing / inventory / pos /
  // cash / accounting / hr / zatca) chosen at registration. The backend
  // expands these into a menuPermissions JSON for the new company.
  selectedModules?: string[];
  plan: string; billingCycle: string;
  startDate?: string; endDate?: string;
  username: string; email?: string; password: string;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "zatca_token";
const SESSION_KEY = "zatca_session";
const MANUAL_SESSION_KEY = "zatca_manual_session_id";
const ACTING_COMPANY_KEY = "zatca_acting_company_id";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [loading, setLoading] = useState(true);
  const [manualSessions, setManualSessions] = useState<ManualSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionIdState] = useState<number | null>(() => {
    const v = localStorage.getItem(MANUAL_SESSION_KEY);
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const [actingCompanyId, setActingCompanyIdState] = useState<number | null>(() => {
    // Per-realm override wins — used by the audit-log in-app iframe
    // popup so an iframe loaded with `#__actAs=N` boots in that tenant's
    // context regardless of what's in localStorage, and stays there for
    // the lifetime of the iframe's JS realm even after wouter strips
    // the hash. The pin lives in a module-level variable that does NOT
    // leak to the parent SA window (each browsing context has its own
    // module instance).
    const realmOverride = readActingCompanyFromRealm();
    if (realmOverride != null) return realmOverride;
    const v = localStorage.getItem(ACTING_COMPANY_KEY);
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const sseRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qc = useQueryClient();

  // Persist + invalidate every cached query when the SuperAdmin enters or
  // exits a tenant — otherwise stale per-company data would linger in the
  // React Query cache and bleed across tenants in the UI.
  const setActingCompany = useCallback((id: number | null) => {
    setActingCompanyIdState(id);
    if (id == null) localStorage.removeItem(ACTING_COMPANY_KEY);
    else localStorage.setItem(ACTING_COMPANY_KEY, String(id));
    // Cancel in-flight queries first so their late responses cannot
    // overwrite the freshly-invalidated cache with old-tenant data; then
    // invalidate everything so list pages immediately re-fetch in the
    // new tenant scope.
    try {
      void qc.cancelQueries();
      void qc.invalidateQueries();
    } catch { /* ignore */ }
  }, [qc]);

  // Keep localStorage in lock-step so setSessionIdGetter() reads stay correct.
  const persistManualSession = useCallback((id: number | null) => {
    setCurrentSessionIdState(id);
    if (id == null) localStorage.removeItem(MANUAL_SESSION_KEY);
    else localStorage.setItem(MANUAL_SESSION_KEY, String(id));
  }, []);

  const apiFetch = useCallback(async (path: string, opts: RequestInit = {}) => {
    const t = localStorage.getItem(TOKEN_KEY);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (t) headers["Authorization"] = `Bearer ${t}`;
    const res = await fetch(`${API_BASE}/api${path}`, { ...opts, headers: { ...headers, ...(opts.headers as any) } });
    return res;
  }, []);

  const checkSession = useCallback(async () => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) { setUser(null); setLoading(false); return; }
    try {
      const res = await apiFetch("/auth/me");
      if (!res.ok) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(SESSION_KEY);
        setUser(null);
        setToken(null);
        // Force-expiry path: also clear manual-session state so a stale id
        // can't bleed into the next login attempt before login() repopulates.
        setManualSessions([]);
        persistManualSession(null);
        return;
      }
      const data = await res.json();
      // Single-session: if sessionId changed → kicked
      const stored = localStorage.getItem(SESSION_KEY);
      if (stored && data.sessionId && stored !== data.sessionId) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(SESSION_KEY);
        setUser(null);
        setToken(null);
        setManualSessions([]);
        persistManualSession(null);
        return;
      }
      setUser(data);
    } catch {
      // network error — keep session
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  // Initial check
  useEffect(() => { checkSession(); }, [checkSession]);

  // Background safety-net poll. Real-time permission/subscription/company
  // changes are now pushed instantly via the SSE channel below, so this
  // poll only exists to (a) catch single-session takeovers when the SSE
  // stream is temporarily down, and (b) refresh after the tab regains
  // focus. We pace it to once per minute and skip ticks while the tab
  // is hidden — this drops idle-tab API traffic by ~6× and keeps us well
  // under Replit Deployments' per-minute request budget when many users
  // have the app open.
  useEffect(() => {
    if (!user) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void checkSession();
    };
    pollRef.current = setInterval(tick, 60_000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) void checkSession();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, checkSession]);

  // Realtime push: open an SSE connection so any change made by SuperAdmin
  // (license limits, plan, status, freeze, etc.) propagates to the user
  // immediately instead of waiting for the 10-second poll. The server sends
  // typed events (subscription_changed | company_changed | permissions_changed);
  // for any of them we re-fetch /auth/me and invalidate every query so cached
  // data reflects the new state right away.
  useEffect(() => {
    // Tear down any prior connection (e.g. when switching users / on logout).
    const closeStream = () => {
      if (sseRef.current) {
        try { sseRef.current.close(); } catch { /* ignore */ }
        sseRef.current = null;
      }
      if (sseRetryRef.current) {
        clearTimeout(sseRetryRef.current);
        sseRetryRef.current = null;
      }
    };

    if (!user) { closeStream(); return; }

    let cancelled = false;
    let retryDelay = 1000; // ms — exponential, capped

    const open = () => {
      if (cancelled) return;
      const tok = localStorage.getItem(TOKEN_KEY);
      if (!tok) return;
      // EventSource cannot send headers, so token rides as a query param.
      const url = `${API_BASE}/api/realtime/session-events?token=${encodeURIComponent(tok)}`;
      let es: EventSource;
      try {
        es = new EventSource(url);
      } catch {
        // Browser refused to construct — back off and retry
        sseRetryRef.current = setTimeout(open, Math.min(retryDelay, 30_000));
        retryDelay = Math.min(retryDelay * 2, 30_000);
        return;
      }
      sseRef.current = es;

      const onRefresh = () => {
        // Re-fetch the user (subscription, permissions, company status) and
        // bust every cached query so list pages re-render with fresh limits.
        void checkSession();
        try { qc.invalidateQueries(); } catch { /* ignore */ }
      };

      es.addEventListener("subscription_changed", onRefresh);
      es.addEventListener("company_changed", onRefresh);
      es.addEventListener("permissions_changed", onRefresh);

      // Cobrowse invite push: agent invited THIS user to a co-browse session.
      // We re-broadcast as a window event so the global CustomerCobrowseWidget
      // (which doesn't have access to AuthContext internals) can react and
      // open the consent dialog without a page reload.
      es.addEventListener("cobrowse_invite", (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("cobrowse:invite", { detail: payload?.meta ?? payload }));
        } catch { /* ignore malformed event */ }
      });
      es.addEventListener("cobrowse_invite_cancelled", (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("cobrowse:invite-cancelled", { detail: payload?.meta ?? payload }));
        } catch { /* ignore */ }
      });

      // WebRTC chat-call signaling: forward to the in-process call bus so the
      // global CallProvider can react (ring, exchange offer/answer/ICE, hang
      // up) without opening a second SSE connection.
      es.addEventListener("call_invite", (e: MessageEvent) => {
        try { const p = JSON.parse(e.data); emitCall("invite", (p?.meta ?? p)); } catch { /* ignore */ }
      });
      es.addEventListener("call_signal", (e: MessageEvent) => {
        try { const p = JSON.parse(e.data); emitCall("signal", (p?.meta ?? p)); } catch { /* ignore */ }
      });
      es.addEventListener("call_end", (e: MessageEvent) => {
        try { const p = JSON.parse(e.data); emitCall("end", (p?.meta ?? p)); } catch { /* ignore */ }
      });

      es.addEventListener("hello", () => {
        // Stream confirmed live → reset backoff for the next disconnect.
        retryDelay = 1000;
      });

      es.onerror = () => {
        // EventSource auto-reconnects, but if the server closed the stream
        // (e.g. token rotated, server restart) we close + back off to avoid
        // tight loops against a 401 response.
        try { es.close(); } catch { /* ignore */ }
        sseRef.current = null;
        if (cancelled) return;
        sseRetryRef.current = setTimeout(open, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };

    open();
    return () => { cancelled = true; closeStream(); };
  }, [user, checkSession, qc]);

  const login = async (username: string, password: string, companyCode?: string) => {
    // Tenant identity is now (companyCode, username, password). The
    // server requires `companyCode` for tenant logins; it's only
    // optional in the SuperAdmin-fast-path case where the universal
    // login endpoint will return 409 + useSuperAdminFlow=true and the
    // page will pivot to the dedicated SuperAdmin flow.
    const trimmedCode = (companyCode ?? "").trim();
    const res = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        ...(trimmedCode ? { companyCode: trimmedCode } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(data.error ?? "حدث خطأ في تسجيل الدخول");
      err.status = res.status;
      err.data = data;            // expose body so callers can detect e.g. useSuperAdminFlow
      throw err;
    }
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(SESSION_KEY, data.sessionId);
    // Defensively clear any stale acting-company id from a previous login
    // (e.g. SA logged out, then a tenant user logs in on the same browser).
    // Without this the new user would still send the header — server ignores
    // it for non-SAs, but the UI banner would render incorrectly until next
    // page reload.
    localStorage.removeItem(ACTING_COMPANY_KEY);
    setActingCompanyIdState(null);
    setToken(data.token);
    setUser(data.user);
    setManualSessions(Array.isArray(data.manualSessions) ? data.manualSessions : []);
    persistManualSession(
      typeof data.currentSessionId === "number" ? data.currentSessionId : null,
    );
  };

  const logout = async () => {
    // Auto-checkout the active tracking visit (if any) so the user's
    // attendance/visit row closes when they sign out — mirror of the
    // useAutoCheckinOnLogin hook. Best-effort: capped by a hard 3-second
    // budget so a slow network or denied-but-pending geolocation prompt
    // can never stall the sign-out. All errors swallowed silently.
    // SuperAdmins are excluded (no tenant attendance footprint).
    try {
      if (user && user.role !== "superadmin") {
        const sleep = (ms: number) => new Promise<null>(r => setTimeout(() => r(null), ms));
        const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
          Promise.race<T | null>([p.catch(() => null), sleep(ms)]);

        const { userTrackingApi, getCurrentPosition } = await import("@/lib/userTrackingApi");
        // Total budget: ~3s. Split between meStatus + geolocation + checkout.
        const st = await withTimeout(userTrackingApi.meStatus(), 1500);
        if (st?.activeVisitId) {
          const pos = await withTimeout(getCurrentPosition(), 1500);
          // Backend checkout requires lat/lng. If geolocation was denied
          // or timed out, fall back to (0,0) so the visit still closes —
          // the checkin location is preserved on the row and duration is
          // computed from timestamps, not coords.
          void withTimeout(userTrackingApi.checkout(st.activeVisitId, {
            lat: pos?.lat ?? 0,
            lng: pos?.lng ?? 0,
            accuracy: pos?.accuracy,
            notes: "تسجيل خروج من النظام",
          }), 1500);
        }
      }
    } catch { /* silent — auto-checkout is a convenience */ }

    await apiFetch("/auth/logout", { method: "POST" });
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACTING_COMPANY_KEY);
    setActingCompanyIdState(null);
    setToken(null);
    setUser(null);
    setManualSessions([]);
    persistManualSession(null);
    // Drop module-level caches that hold per-user data so the next login
    // starts fresh (currently: voice-assistant effective settings).
    try { (globalThis as any).__clearVoiceSettingsCache?.(); } catch { /* ignore */ }
  };

  const register = async (data: RegisterData) => {
    const res = await apiFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? "حدث خطأ في إنشاء الحساب");
    localStorage.setItem(TOKEN_KEY, result.token);
    localStorage.setItem(SESSION_KEY, result.sessionId);
    setToken(result.token);
    setUser(result.user);
  };

  const setSession = useCallback((args: { token: string; sessionId?: string | null; user: AuthUser }) => {
    localStorage.setItem(TOKEN_KEY, args.token);
    if (args.sessionId) localStorage.setItem(SESSION_KEY, args.sessionId);
    setToken(args.token);
    setUser(args.user);
    setLoading(false);
  }, []);

  const refreshManualSessions = useCallback(async () => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    try {
      const res = await apiFetch("/sessions/me");
      if (!res.ok) return;
      const data = await res.json();
      const list: ManualSessionSummary[] = Array.isArray(data?.sessions) ? data.sessions : [];
      setManualSessions(list);
      const sid = typeof data?.currentSessionId === "number" ? data.currentSessionId : null;
      // Server self-heals stale selections — mirror that locally.
      persistManualSession(sid);
    } catch { /* network / JSON noise — keep current state */ }
  }, [apiFetch, persistManualSession]);

  const selectManualSession = useCallback(async (sessionId: number | null) => {
    const res = await apiFetch("/sessions/me/select", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? "تعذر تحديد الجلسة");
    }
    persistManualSession(sessionId);
  }, [apiFetch, persistManualSession]);

  const quickCreateManualSession = useCallback(async (name: string) => {
    const res = await apiFetch("/sessions/me/quick-create", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "تعذر إنشاء الجلسة");
    // Server auto-selected the new session — sync state.
    await refreshManualSessions();
  }, [apiFetch, refreshManualSessions]);

  // When the user (re)appears (initial /me succeeded after a reload), pull
  // fresh manual sessions in case the assignment changed in another tab.
  useEffect(() => {
    if (user) void refreshManualSessions();
  }, [user, refreshManualSessions]);

  return (
    <AuthContext.Provider value={{
      user, token, loading,
      login, logout, register,
      setUser, setSession,
      isAuthenticated: !!user,
      manualSessions, currentSessionId,
      selectManualSession, quickCreateManualSession, refreshManualSessions,
      actingCompanyId, setActingCompany,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
