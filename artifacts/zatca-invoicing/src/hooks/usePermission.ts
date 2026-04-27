import { useAuth } from "@/contexts/AuthContext";
import { companyAllowsModule } from "@/lib/companyModuleGate";

// ─── Permission hook ──────────────────────────────────────────────────────
// Mirrors the backend `requirePermission` rule exactly:
//   - superadmin → full access (platform operator).
//   - the company-level gate (companies.menuPermissions) is an UPPER bound
//     applied to EVERY non-superadmin role, including the company's own
//     admin. When SuperAdmin disables a module on a company, that module's
//     buttons/screens are hidden even from the company admin.
//   - admin → bypasses the per-action user permission check (still bounded
//     by the company gate above).
//   - else → permissions[module][action] === true.
//
// Use for button-level gating (disable/hide save buttons etc.) and as the
// hook that powers <RequirePermission/> and <PermRoute/>.
//
// Example:
//   const canCreate = usePermission("sales_invoices", "create");
// ──────────────────────────────────────────────────────────────────────────

export type PermAction = "view" | "create" | "edit" | "delete" | "post" | "export";

export function usePermission(module: string, action: PermAction = "view"): boolean {
  const { user } = useAuth() as any;
  if (!user) return false;
  if (user.role === "superadmin") return true;
  if (!companyAllowsModule(user, module)) return false;
  if (user.role === "admin") return true;
  const perm = (user.permissions ?? {})[module];
  return !!perm?.[action];
}
