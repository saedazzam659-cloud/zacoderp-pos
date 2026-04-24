import { useAuth } from "@/contexts/AuthContext";

// ─── Permission hook ──────────────────────────────────────────────────────
// Mirrors the backend `requirePermission` rule exactly:
//   - admin / superadmin → full access (return true)
//   - else → permissions[module][action] === true
//
// Use for button-level gating (disable/hide save buttons etc.) and as the
// hook that powers <RequirePermission/>.
//
// Example:
//   const canCreate = usePermission("sales_invoices", "create");
// ──────────────────────────────────────────────────────────────────────────

export type PermAction = "view" | "create" | "edit" | "delete" | "post" | "export";

export function usePermission(module: string, action: PermAction = "view"): boolean {
  const { user } = useAuth() as any;
  if (!user) return false;
  if (user.role === "superadmin" || user.role === "admin") return true;
  const perm = (user.permissions ?? {})[module];
  return !!perm?.[action];
}
