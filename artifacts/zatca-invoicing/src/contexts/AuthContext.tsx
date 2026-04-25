import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Register auth token getter for the generated API client so all hooks automatically include Bearer token
setAuthTokenGetter(() => localStorage.getItem("zatca_token"));

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
  company?: any;
  subscription?: any;
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
}

export interface RegisterData {
  nameAr: string; nameEn?: string;
  vatNumber: string; crNumber: string;
  city?: string; district?: string; street?: string;
  buildingNumber?: string; postalCode?: string; country?: string;
  industryName?: string; invoiceType?: string;
  plan: string; billingCycle: string;
  startDate?: string; endDate?: string;
  username: string; email?: string; password: string;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "zatca_token";
const SESSION_KEY = "zatca_session";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  };

  const logout = async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    setToken(null);
    setUser(null);
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

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, register, setUser, setSession, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
