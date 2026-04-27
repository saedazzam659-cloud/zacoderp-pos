import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { setAuthTokenGetter, setSessionIdGetter } from "@workspace/api-client-react";

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
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  setUser: React.Dispatch<React.SetStateAction<AuthUser | null>>;
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Poll every 10s for single-session enforcement and real-time permission updates
  useEffect(() => {
    if (user) {
      pollRef.current = setInterval(checkSession, 10000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [user, checkSession]);

  const login = async (username: string, password: string) => {
    const res = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
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
    setToken(data.token);
    setUser(data.user);
    setManualSessions(Array.isArray(data.manualSessions) ? data.manualSessions : []);
    persistManualSession(
      typeof data.currentSessionId === "number" ? data.currentSessionId : null,
    );
  };

  const logout = async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    setToken(null);
    setUser(null);
    setManualSessions([]);
    persistManualSession(null);
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
