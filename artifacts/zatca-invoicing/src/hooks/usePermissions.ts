import { useAuth } from "@/contexts/AuthContext";
import type { Action, PermissionMap } from "@/lib/permissions";

// Returns helpers tied to the current user.
// admin / superadmin → full access regardless of permission map.
export function usePermissions() {
  const { user } = useAuth();

  const role = user?.role;
  const isSuper = role === "superadmin";
  const isAdmin = role === "admin" || isSuper;

  const map = ((user as any)?.permissions as PermissionMap | undefined) ?? {};

  const can = (moduleKey: string, action: Action = "view"): boolean => {
    if (isAdmin) return true;
    return Boolean(map[moduleKey]?.[action]);
  };

  const canAny = (moduleKey: string): boolean => {
    if (isAdmin) return true;
    const m = map[moduleKey] ?? {};
    return Object.values(m).some(Boolean);
  };

  return { can, canAny, isAdmin, isSuper, role };
}
