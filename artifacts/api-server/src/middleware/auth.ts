import { db } from "@workspace/db";
import { usersTable, userBranchesTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";

export interface AuthUser {
  id: number;
  username: string;
  role: string;
  companyId: number | null;
  // Granular per-module action map. Shape: { [moduleKey]: { view?: bool, ... } }
  // Loaded from users.permissions jsonb. May be null/undefined for legacy users
  // and is always undefined for superadmin/admin (they bypass granular checks).
  permissions?: Record<string, Record<string, boolean>> | null;
  // Branch-scope visibility. true → user can see every branch of their company.
  // false → user can only see data from branchIds they are linked to.
  viewAllBranches: boolean;
  // Branches this user is explicitly linked to (from user_branches).
  branchIds: number[];
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

/**
 * Extracts user from Bearer token and attaches to req.authUser.
 * Does NOT block unauthenticated requests — check req.authUser in route handlers.
 */
export async function extractAuth(req: Request, _res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { next(); return; }
  const token = auth.slice(7);
  const [user] = await db
    .select({
      id:               usersTable.id,
      username:         usersTable.username,
      role:             usersTable.role,
      companyId:        usersTable.companyId,
      isActive:         usersTable.isActive,
      permissions:      usersTable.permissions,
      viewAllBranches:  usersTable.viewAllBranches,
    })
    .from(usersTable)
    .where(eq(usersTable.sessionToken, token));
  if (user?.isActive) {
    // Load explicit branch grants (only relevant when viewAllBranches=false,
    // but cheap enough to load always — typically a tiny list per user).
    const links = await db
      .select({ branchId: userBranchesTable.branchId })
      .from(userBranchesTable)
      .where(eq(userBranchesTable.userId, user.id));
    req.authUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      companyId: user.companyId,
      permissions: user.permissions as any,
      viewAllBranches: user.viewAllBranches,
      branchIds: links.map(l => l.branchId),
    };
  }
  next();
}

/**
 * Resolves the effective companyId for a request:
 * - superadmin: uses ?companyId query param (or undefined = all)
 * - company user: always forces their own companyId (ignores query param)
 */
export function resolveCompanyId(req: Request, queryCompanyId?: number): number | undefined {
  if (!req.authUser) return queryCompanyId;
  if (req.authUser.role === "superadmin") return queryCompanyId;
  return req.authUser.companyId ?? undefined;
}

// ─── Branch-scope helpers ─────────────────────────────────────────────────
// These power the "view-all-branches vs only-my-branches" feature. Use them
// across every list/aggregate endpoint that surfaces branch-tied data.

/**
 * Returns the list of branchIds the user is allowed to query, or `null` if
 * there is no restriction (admin / superadmin / viewAllBranches=true).
 *
 *   null  → no restriction (show every branch)
 *   []    → restricted user with zero linked branches → show NOTHING
 *   [...] → restricted to these branchIds
 */
export function getAllowedBranchIds(req: Request): number[] | null {
  const u = req.authUser;
  if (!u) return null;
  if (u.role === "superadmin" || u.role === "admin") return null;
  if (u.viewAllBranches) return null;
  return u.branchIds ?? [];
}

/**
 * Builds a Drizzle SQL condition that restricts the given branch column to
 * the user's allowed branches. Returns `undefined` when there is no
 * restriction (caller should simply skip it). Returns a "false" condition
 * when the user has zero allowed branches so the query yields no rows.
 *
 * Usage:
 *   const branchCond = branchScopeFilter(req, salesInvoicesTable.branchId);
 *   const where = and(eq(salesInvoicesTable.companyId, cid), branchCond);
 */
export function branchScopeFilter(req: Request, branchColumn: any) {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return inArray(branchColumn, allowed);
}

/**
 * Narrows the supplied requested branchId against the user's allowed scope.
 * - If the user has no restriction, the requested value is returned as-is.
 * - If the requested branch is allowed, returned as-is.
 * - If the requested branch is NOT allowed, returns the literal value
 *   `"deny"` so the caller can short-circuit to an empty result.
 * - When no specific branch is requested by a restricted user, returns `null`
 *   meaning "use the user's allowed list via branchScopeFilter()".
 */
export function intersectBranchRequest(
  req: Request,
  requested: number | undefined | null,
): number | null | "deny" {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return requested ?? null;
  if (requested == null) return null; // let scope filter handle it
  return allowed.includes(Number(requested)) ? Number(requested) : "deny";
}
