import type { AuthUser } from "../middleware/auth.js";

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
 * A warehouse option is visible only when it belongs to the project's branch.
 * There is intentionally no company-wide / NULL-branch fallback here:
 * returning such a row would also return balances for a branch the caller
 * cannot inspect.
 */
export function contractingWarehouseAllowed(
  projectBranchId: number | null | undefined,
  warehouseBranchId: number | null | undefined,
): boolean {
  return projectBranchId != null
    && warehouseBranchId != null
    && Number(projectBranchId) === Number(warehouseBranchId);
}