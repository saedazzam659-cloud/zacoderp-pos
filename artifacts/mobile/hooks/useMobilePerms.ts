import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { api, getDomain, isCurrentSession, sessionGeneration } from '@/lib/api';
import { effectiveMobilePermission, mobilePermsQueryKey, normalizeMe, verifiedMeForSession } from './mobilePermsPolicy';

// ─── صلاحيات تطبيق الموبايل (users.mobile_permissions) ────────────────────
// الدلالة تطابق السيرفر (api-server lib/mobilePerms.ts):
//   NULL / مفتاح غير موجود = مسموح (توافق رجعي)، false صريحة = ممنوع،
//   admin/superadmin مسموح دائماً.
// نعيد قراءة /api/auth/me كل 30 ثانية وعند عودة التطبيق للواجهة، فتظهر
// تغييرات الصلاحيات من شاشة المستخدمين في الويب فوراً دون إعادة تسجيل دخول.
export function useMobilePerms() {
  const { user } = useAuth();
  const generation = sessionGeneration();
  const companyId = typeof user?.companyId === 'number' ? user.companyId : user?.company?.id ?? null;
  const identity = user ? { id: user.id, companyId } : null;
  const q = useQuery({
    queryKey: mobilePermsQueryKey(generation, identity),
    queryFn: async () => {
      const domain = await getDomain();
      if (!isCurrentSession(generation)) throw new Error('تغيّرت جلسة الخادم');
      const fresh = normalizeMe(await api<unknown>('/api/auth/me'));
      if (!isCurrentSession(generation) || !identity || fresh.id !== identity.id ||
          (fresh.companyId ?? null) !== identity.companyId || domain !== await getDomain()) {
        throw new Error('استجابة صلاحيات تخص جلسة مختلفة');
      }
      return fresh;
    },
    enabled: !!user,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
  });
  // React Query retains the last successful data after a network error. Keep
  // using it only within this identity/session key; never allow an initial
  // unauthenticated failure to fall back to the login user's missing map.
  const verified = isCurrentSession(generation) && verifiedMeForSession(identity, q.data ?? null, q.dataUpdatedAt, generation, sessionGeneration());
  const fresh = verified ? q.data ?? null : null;

  const mp = useCallback(
    (key: string): boolean => effectiveMobilePermission(
      user ? { id: user.id, companyId, role: user.role } : null,
      fresh,
      verified,
      key,
    ),
    [user, companyId, fresh, verified],
  );

  return {
    mp,
    refetch: q.refetch,
    status: !user ? 'غير مسجل' : q.isFetching ? 'جارٍ التحديث' : q.isError ? verified ? 'تعذّر التحديث — آخر صلاحيات مؤكدة' : 'فشل التحديث — لا صلاحيات مؤكدة' : verified ? 'محدّث' : 'بانتظار التحديث',
    updatedAt: verified ? q.dataUpdatedAt : null,
    errorAt: q.isError ? q.errorUpdatedAt : null,
  };
}
