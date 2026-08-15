import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';

// ─── صلاحيات تطبيق الموبايل (users.mobile_permissions) ────────────────────
// الدلالة تطابق السيرفر (api-server lib/mobilePerms.ts):
//   NULL / مفتاح غير موجود = مسموح (توافق رجعي)، false صريحة = ممنوع،
//   admin/superadmin مسموح دائماً.
// نعيد قراءة /api/auth/me كل 30 ثانية وعند عودة التطبيق للواجهة، فتظهر
// تغييرات الصلاحيات من شاشة المستخدمين في الويب فوراً دون إعادة تسجيل دخول.
export function useMobilePerms() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['me-mobile-perms'],
    queryFn: () => api<any>('/api/auth/me'),
    enabled: !!user,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30_000,
  });
  const fresh = q.data && q.data.id ? q.data : null;
  const role = String(fresh?.role ?? user?.role ?? '');
  const map = (fresh?.mobilePermissions ?? (user as any)?.mobilePermissions) as
    | Record<string, boolean>
    | null
    | undefined;

  const mp = useCallback(
    (key: string): boolean => {
      if (!user) return false;
      if (role === 'admin' || role === 'superadmin') return true;
      if (map == null || typeof map !== 'object') return true;
      return map[key] !== false;
    },
    [user, role, map],
  );

  return { mp, refetch: q.refetch };
}
