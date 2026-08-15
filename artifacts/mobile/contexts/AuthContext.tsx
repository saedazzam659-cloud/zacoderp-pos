import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, setToken, getToken } from '@/lib/api';
import { clearAllOfflineData } from '@/lib/offline';

export interface CompanyInfo {
  id: number;
  nameAr?: string;
  nameEn?: string;
  vatNumber?: string;
  taxCalculationMode?: string;
  invoiceType?: string; // standard | simplified | both
  [k: string]: unknown;
}

export interface AuthUser {
  id: number;
  username: string;
  role: string;
  permissions?: Record<string, Record<string, boolean>>;
  company?: CompanyInfo;
  branchIds?: number[];
  viewAllBranches?: boolean;
  [k: string]: unknown;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (companyCode: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (module: string, action?: string) => boolean;
  companyId: number | null;
}

const AuthContext = createContext<AuthState | null>(null);

const LAST_COMPANY_CODE = 'zacod_last_company_code';
const LAST_USERNAME = 'zacod_last_username';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const me = await api<any>('/api/auth/me');
        const u: AuthUser | null = me?.user ?? me ?? null;
        if (u && u.id) setUser(u);
        else await setToken(null);
      } catch {
        // token invalid/expired — stay logged out (keep token cleared on 401 only at next login)
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (companyCode: string, username: string, password: string) => {
    const data = await api<any>('/api/auth/login', {
      method: 'POST',
      body: { companyCode: companyCode.trim(), username: username.trim(), password },
    });
    if (!data?.token || !data?.user) {
      throw new Error(data?.error || 'فشل تسجيل الدخول');
    }
    await setToken(data.token);
    await AsyncStorage.setItem(LAST_COMPANY_CODE, companyCode.trim());
    await AsyncStorage.setItem(LAST_USERNAME, username.trim());
    setUser(data.user as AuthUser);
  }, []);

  const logout = useCallback(async () => {
    await setToken(null);
    // أمان تعدد المستخدمين على نفس الجهاز: مسح كاش الأوف لاين وصندوق الصادر
    await clearAllOfflineData().catch(() => {});
    setUser(null);
  }, []);

  const can = useCallback(
    (module: string, action: string = 'view') => {
      if (!user) return false;
      if (user.role === 'admin' || user.role === 'superadmin') return true;
      return !!user.permissions?.[module]?.[action];
    },
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login,
      logout,
      can,
      companyId: user?.company?.id ?? null,
    }),
    [user, loading, login, logout, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export async function getRememberedLogin(): Promise<{ companyCode: string; username: string }> {
  const [c, u] = await Promise.all([
    AsyncStorage.getItem(LAST_COMPANY_CODE),
    AsyncStorage.getItem(LAST_USERNAME),
  ]);
  return { companyCode: c ?? '', username: u ?? '' };
}
