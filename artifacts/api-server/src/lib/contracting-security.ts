import type { AuthUser } from "../middleware/auth.js";
import { requirePermission, type PermAction } from "../middleware/permissions.js";
import type { Request, Response, NextFunction } from "express";

/**
 * Contracting is branch-owned data.  Unlike company-wide catalog rows, a
 * project without a branch is not a usable fallback for a branch-restricted
 * user.  Keep this predicate pure so route guards can be unit-tested without
 * booting Express or the database.
 */
export function contractingBranchAllowed(
  user: Pick<AuthUser, "role" | "viewAllBranches" | "branchIds"> | null | undefined,
  branchId: number | null | undefined,
): boolean {
  if (!user || user.role === "admin" || user.role === "superadmin" || user.viewAllBranches) {
    return true;
  }
  return branchId != null && (user.branchIds ?? []).includes(Number(branchId));
}

/**
 * Legacy contracting routes are still mounted beside the accounting router.
 * Map HTTP mutations to the existing granular permission actions instead of
 * relying on the router-wide `contracting:view` check.
 */
export function contractingMutationAction(
  method: string,
): "create" | "edit" | "delete" | null {
  switch (method.toUpperCase()) {
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "edit";
    case "DELETE":
      return "delete";
    default:
      return null;
  }
}

/**
 * A warehouse option is visible when it belongs to the project's branch or is
 * a company-wide (NULL-branch) warehouse.  Company-wide warehouses are part
 * of the inventory read scope for every branch; the company predicate remains
 * enforced by the caller's query.  A project without a branch can therefore
 * use a company-wide warehouse, but must not silently select a branch-specific
 * warehouse: doing so would infer the project's branch from the user's choice.
 */
export function contractingWarehouseAllowed(
  projectBranchId: number | null | undefined,
  warehouseBranchId: number | null | undefined,
): boolean {
  return warehouseBranchId == null
    || (projectBranchId != null && Number(projectBranchId) === Number(warehouseBranchId));
}

/**
 * Keep the distinction between an ordinary branch mismatch and a project
 * whose branch is genuinely unknown.  Callers use this for a user-facing
 * validation error rather than returning an apparently valid empty picker.
 */
export function contractingWarehouseError(
  projectBranchId: number | null | undefined,
  warehouseBranchId: number | null | undefined,
): string | null {
  if (contractingWarehouseAllowed(projectBranchId, warehouseBranchId)) return null;
  return projectBranchId == null
    ? "يجب تحديد فرع المشروع قبل اختيار مخزن مرتبط بفرع"
    : "المخزن لا يتبع فرع المشروع";
}

/**
 * Detail/accounting workflow capabilities were added after the original
 * contracting create/edit/post map. An omitted capability falls back to the
 * legacy action, while an explicit false remains a denial.
 */
export function requireContractingCapability(
  capability: PermAction,
  fallback: PermAction = "post",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.authUser as any;
    if (user?.role === "admin" || user?.role === "superadmin") {
      next();
      return;
    }
    const permissions = user?.permissions?.contracting;
    if (permissions && permissions[capability] === false) {
      res.status(403).json({ error: "لا تملك صلاحية تنفيذ هذا الإجراء" });
      return;
    }
    if (permissions && permissions[capability] === true) {
      next();
      return;
    }
    requirePermission("contracting", fallback)(req, res, next);
  };
}