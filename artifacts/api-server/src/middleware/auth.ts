import { db } from "@workspace/db";
import { usersTable, userBranchesTable, superAdminSessionsTable } from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
 * Resolves a Bearer token against either:
 *   - users.sessionToken (legacy single-session for normal users), or
 *   - sa_sessions.sessionToken (SuperAdmin multi-session, multi-factor flow).
 *
 * Returns the user row (subset of columns), the resolved sessionId string
 * for client kick-detection, and an `origin` discriminator. Returns null
 * when the token does not match either store.
 */
export async function resolveBearerToken(token: string): Promise<{
  user: {
    id: number; username: string; role: string; companyId: number | null;
    isActive: boolean; permissions: any; viewAllBranches: boolean; email: string | null;
    sessionId: string | null;
  };
  origin: "user" | "superadmin";
  saSessionRowId?: number;
} | null> {
  // 1) Legacy single-session
  const [u] = await db
    .select({
      id: usersTable.id, username: usersTable.username, role: usersTable.role,
      companyId: usersTable.companyId, isActive: usersTable.isActive,
      permissions: usersTable.permissions, viewAllBranches: usersTable.viewAllBranches,
      email: usersTable.email, sessionId: usersTable.sessionId,
      currentSessionId: usersTable.currentSessionId,
    })
    .from(usersTable)
    .where(eq(usersTable.sessionToken, token));
  if (u?.isActive) return { user: u, origin: "user" };

  // 2) SuperAdmin multi-session
  const [s] = await db
    .select({
      sId: superAdminSessionsTable.id,
      userId: superAdminSessionsTable.userId,
      revokedAt: superAdminSessionsTable.revokedAt,
    })
    .from(superAdminSessionsTable)
    .where(and(eq(superAdminSessionsTable.sessionToken, token), isNull(superAdminSessionsTable.revokedAt)))
    .limit(1);
  if (!s) return null;

  const [su] = await db
    .select({
      id: usersTable.id, username: usersTable.username, role: usersTable.role,
      companyId: usersTable.companyId, isActive: usersTable.isActive,
      permissions: usersTable.permissions, viewAllBranches: usersTable.viewAllBranches,
      email: usersTable.email,
      currentSessionId: usersTable.currentSessionId,
    })
    .from(usersTable)
    .where(eq(usersTable.id, s.userId));
  if (!su?.isActive || su.role !== "superadmin") return null;

  // Use the SA session row id as the stable sessionId so the client
  // /api/auth/me poll matches what was stored on login (multi-session safe).
  return {
    user: { ...su, sessionId: `sa-${s.sId}` },
    origin: "superadmin",
    saSessionRowId: s.sId,
  };
}

/**
 * Extracts user from Bearer token and attaches to req.authUser.
 * Does NOT block unauthenticated requests — check req.authUser in route handlers.
 * Recognises both regular session tokens and SuperAdmin session tokens.
 */
export async function extractAuth(req: Request, _res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { next(); return; }
  const token = auth.slice(7);

  const resolved = await resolveBearerToken(token);
  if (!resolved) { next(); return; }
  const { user } = resolved;

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

  // Manual-session header (`x-session-id`). Honoured only when the value
  // matches the user's persisted currentSessionId — that field is set via
  // POST /api/sessions/me/select after the server has already verified the
  // user is assigned to (and the session is active for) that ID. This makes
  // header-trust safe without re-querying session_users on every request.
  const headerVal = (req.headers["x-session-id"] as string | undefined) ?? "";
  const headerSid = parseInt(headerVal, 10);
  if (Number.isFinite(headerSid) && headerSid > 0 && (user as any).currentSessionId === headerSid) {
    (req as any).manualSessionId = headerSid;
  } else {
    (req as any).manualSessionId = null;
  }

  // Refresh SA session lastSeenAt (best-effort).
  if (resolved.origin === "superadmin" && resolved.saSessionRowId) {
    db.update(superAdminSessionsTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(superAdminSessionsTable.id, resolved.saSessionRowId))
      .catch(() => { /* non-fatal */ });
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

/**
 * One-stop branch enforcement for any list / aggregate endpoint.
 *
 * Combines the explicit `?branchId=` query param chosen by the caller with
 * the per-user `viewAllBranches` / `userBranches` scope. Returns either:
 *
 *   { deny: true }                 → restricted user requested a branch
 *                                    they are not linked to. Caller should
 *                                    short-circuit with an empty result.
 *   { cond: <Drizzle SQL | undef>} → AND-able condition for the WHERE
 *                                    clause. May be `undefined` (admin /
 *                                    superadmin / viewAll user with no
 *                                    explicit filter) — in that case the
 *                                    caller pushes nothing.
 *
 * Usage:
 *   const branch = effectiveBranchCondition(req, salesInvoicesTable.branchId, req.query.branchId);
 *   if (branch.deny) return res.json([]);
 *   const where = and(eq(salesInvoicesTable.companyId, cid), branch.cond);
 */
export function effectiveBranchCondition(
  req: Request,
  branchColumn: any,
  requestedRaw: unknown,
): { deny: true } | { deny?: false; cond: any | undefined } {
  const reqId =
    requestedRaw === undefined || requestedRaw === null || requestedRaw === ""
      ? null
      : Number(requestedRaw);
  const intersect = intersectBranchRequest(
    req,
    Number.isFinite(reqId as number) ? (reqId as number) : null,
  );
  if (intersect === "deny") return { deny: true };
  if (typeof intersect === "number") return { cond: eq(branchColumn, intersect) };
  return { cond: branchScopeFilter(req, branchColumn) };
}

/**
 * Convenience: pushes the effective branch condition into a conds[] array.
 *
 * Returns "deny" so callers MAY short-circuit to an empty response, but
 * also pushes `sql\`false\`` on deny so that callers which forget to check
 * still produce zero rows instead of leaking unfiltered data.
 */
export function pushBranchScope(
  req: Request,
  conds: any[],
  branchColumn: any,
  requestedRaw: unknown,
): "ok" | "deny" {
  const r = effectiveBranchCondition(req, branchColumn, requestedRaw);
  if (r.deny) {
    conds.push(sql`false`);
    return "deny";
  }
  if (r.cond) conds.push(r.cond);
  return "ok";
}

/**
 * Convenience: returns an array of conditions to spread into an existing
 * `and(...)` / `where(and(...))` clause. Empty array means no restriction.
 * Important: a "deny" (restricted user requesting a forbidden branch) is
 * encoded as `[sql\`false\`]` so the surrounding query still returns zero
 * rows without the caller having to short-circuit.
 */
export function branchScopeSpread(
  req: Request,
  branchColumn: any,
  requestedRaw: unknown,
): any[] {
  const r = effectiveBranchCondition(req, branchColumn, requestedRaw);
  if (r.deny) return [sql`false`];
  return r.cond ? [r.cond] : [];
}
