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

  // Poll every 30s for single-session enforcement
  useEffect(() => {
    if (user) {
      pollRef.current = setInterval(checkSession, 30000);
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "حدث خطأ في تسجيل الدخول");
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

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, register, setUser, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
