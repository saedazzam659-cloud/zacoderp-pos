import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import { api, setToken, getToken, getDomain, normalizeDomain, probeDomain, setDomain, sessionGeneration, isCurrentSession, invalidateRequests, registerSessionExpired } from '@/lib/api';
import { clearAllOfflineData, offlineOperationsBusy, outboxCounts, allOutboxCounts } from '@/lib/offline';

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
  switchServer: (input: string) => Promise<string>;
  can: (module: string, action?: string) => boolean;
  companyId: number | null;
}

const AuthContext = createContext<AuthState | null>(null);

const LAST_COMPANY_CODE = 'zacod_last_company_code';
const LAST_USERNAME = 'zacod_last_username';
const LAST_DOMAIN = 'zacod_last_login_domain';
const OWNER_PREFIX = 'zacod_offline_owner:';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    registerSessionExpired(() => {
      setUser(null);
      queryClient.cancelQueries().then(() => queryClient.clear());
    });
    return () => registerSessionExpired(null);
  }, [queryClient]);

  useEffect(() => {
    (async () => {
      const snapshot = sessionGeneration();
      try {
        const token = await getToken();
        if (!isCurrentSession(snapshot)) return;
        if (!token) return;
        const me = await api<any>('/api/auth/me');
        if (!isCurrentSession(snapshot)) return;
        const u: AuthUser | null = me?.user ?? me ?? null;
        if (u && u.id) setUser(u);
        else { setUser(null); await setToken(null, snapshot); }
      } catch {
        if (isCurrentSession(snapshot)) {
          setUser(null);
          await setToken(null, snapshot);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (companyCode: string, username: string, password: string) => {
    const snapshot = sessionGeneration();
    const domain = await getDomain();
    const data = await api<any>('/api/auth/login', {
      method: 'POST',
      body: { companyCode: companyCode.trim(), username: username.trim(), password },
    });
    if (!data?.token || !data?.user) {
      throw new Error(data?.error || 'فشل تسجيل الدخول');
    }
    if (!isCurrentSession(snapshot)) throw new Error('تغيّر الخادم — أعد تسجيل الدخول');
    const counts = await outboxCounts(domain);
    if (counts.pending || counts.failed) {
      const owner = await AsyncStorage.getItem(OWNER_PREFIX + domain);
      const identity = `${data.user.company?.id ?? data.user.companyId ?? ''}:${data.user.id}`;
      const remembered = !owner ? await getRememberedLogin() : null;
      const legacySameAccount = !owner && domain === 'zacoderp.com' &&
        remembered?.companyCode === companyCode.trim() && remembered?.username === username.trim();
      if (!legacySameAccount && owner !== identity) {
        throw new Error('يوجد صادر غير مُزامن يخص حساباً آخر على هذا الخادم. سجّل الدخول بالحساب الأصلي ثم زامن العمليات قبل تغيير الحساب.');
      }
    }
    if (!await setToken(data.token, snapshot)) throw new Error('تغيّر الخادم — أعد تسجيل الدخول');
    const issued = sessionGeneration();
    if (!isCurrentSession(issued)) throw new Error('تغيّر الخادم — أعد تسجيل الدخول');
    await AsyncStorage.setItem(OWNER_PREFIX + domain, `${data.user.company?.id ?? data.user.companyId ?? ''}:${data.user.id}`);
    await AsyncStorage.setItem(LAST_COMPANY_CODE, companyCode.trim());
    await AsyncStorage.setItem(LAST_USERNAME, username.trim());
    await AsyncStorage.setItem(LAST_DOMAIN, domain);
    if (!isCurrentSession(issued)) throw new Error('تغيّر الخادم — أعد تسجيل الدخول');
    setUser(data.user as AuthUser);
  }, []);

  const logout = useCallback(async () => {
    const counts = await allOutboxCounts();
    if (offlineOperationsBusy() || counts.pending || counts.failed) {
      throw new Error('توجد عمليات أوف لاين غير مزامنة. زامنها أو راجع العمليات الفاشلة قبل تسجيل الخروج.');
    }
    invalidateRequests();
    setUser(null);
    await setToken(null);
    await queryClient.cancelQueries();
    queryClient.clear();
    await clearAllOfflineData();
  }, [queryClient]);

  const switchServer = useCallback(async (input: string) => {
    const next = normalizeDomain(input);
    let current: string | null = null;
    try { current = await getDomain(); } catch { /* allow correcting a legacy invalid saved host */ }
    if (next === current) return current;
    await probeDomain(next);
    const counts = await allOutboxCounts();
    if (offlineOperationsBusy() || counts.pending || counts.failed) {
      throw new Error('توجد عمليات أوف لاين لم تُزامن بعد. زامن الصادر وراجع العمليات الفاشلة على الخادم الحالي قبل التبديل. لن تُحذف بياناتك.');
    }
    // No await between the final outbox check and session invalidation.
    invalidateRequests();
    setUser(null);
    await queryClient.cancelQueries();
    queryClient.clear();
    await setDomain(next);
    await clearAllOfflineData();
    await AsyncStorage.multiRemove([LAST_COMPANY_CODE, LAST_USERNAME, LAST_DOMAIN]);
    return next;
  }, [queryClient]);

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
      switchServer,
      can,
      companyId: user?.company?.id ?? null,
    }),
    [user, loading, login, logout, switchServer, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export async function getRememberedLogin(): Promise<{ companyCode: string; username: string }> {
  const [c, u, bound, domain] = await Promise.all([
    AsyncStorage.getItem(LAST_COMPANY_CODE),
    AsyncStorage.getItem(LAST_USERNAME),
    AsyncStorage.getItem(LAST_DOMAIN),
    getDomain(),
  ]);
  // Legacy credentials belong only to the original central deployment.
  if (bound !== domain && (bound || domain !== 'zacoderp.com')) return { companyCode: '', username: '' };
  return { companyCode: c ?? '', username: u ?? '' };
}
