// /auth/me is direct today; accept the login-style { user } envelope as well.
// Reject malformed responses rather than treating them as an "allow all" null map.
export type PermUser = {
  id: number;
  role: string;
  companyId?: number | null;
  mobilePermissions?: Record<string, boolean> | null;
};

export function mobilePermsQueryKey(generation: number, user: { id: number; companyId: number | null } | null) {
  return ['me-mobile-perms', generation, user?.companyId ?? null, user?.id ?? null] as const;
}

export function verifiedMeForSession(
  user: { id: number; companyId?: number | null } | null,
  fresh: PermUser | null,
  dataUpdatedAt: number,
  queryGeneration: number,
  currentGeneration: number,
): boolean {
  return !!user && !!fresh && dataUpdatedAt > 0 && queryGeneration === currentGeneration &&
    fresh.id === user.id && (fresh.companyId ?? null) === (user.companyId ?? null);
}

export function normalizeMe(payload: unknown): PermUser {
  if (!payload || typeof payload !== 'object') throw new Error('استجابة صلاحيات غير صالحة');
  const envelope = payload as Record<string, unknown>;
  const raw = Object.prototype.hasOwnProperty.call(envelope, 'user') ? envelope.user : payload;
  if (!raw || typeof raw !== 'object') throw new Error('استجابة صلاحيات غير صالحة');
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isFinite(record.id) || typeof record.role !== 'string') {
    throw new Error('هوية استجابة الصلاحيات غير صالحة');
  }
  if (record.mobilePermissions !== null && record.mobilePermissions !== undefined &&
      (typeof record.mobilePermissions !== 'object' || Array.isArray(record.mobilePermissions))) {
    throw new Error('خريطة الصلاحيات غير صالحة');
  }
  if (record.mobilePermissions && Object.values(record.mobilePermissions).some((value) => typeof value !== 'boolean')) {
    throw new Error('قيم الصلاحيات غير صالحة');
  }
  return record as PermUser;
}

export function effectiveMobilePermission(
  user: PermUser | null,
  fresh: PermUser | null,
  verifiedInCurrentSession: boolean,
  key: string,
): boolean {
  if (!user || !verifiedInCurrentSession || !fresh || fresh.id !== user.id ||
      (fresh.companyId ?? null) !== (user.companyId ?? null)) return false;
  if (fresh.role === 'admin' || fresh.role === 'superadmin') return true;
  // The server treats NULL and absent keys as allowed for backwards compatibility.
  // The fresh response is authoritative, even when its map is null.
  const map = fresh.mobilePermissions;
  return map == null || map[key] !== false;
}