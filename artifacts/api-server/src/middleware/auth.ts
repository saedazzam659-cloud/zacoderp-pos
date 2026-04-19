import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";

export interface AuthUser {
  id: number;
  username: string;
  role: string;
  companyId: number | null;
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
    .select({ id: usersTable.id, username: usersTable.username, role: usersTable.role, companyId: usersTable.companyId, isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.sessionToken, token));
  if (user?.isActive) req.authUser = user;
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
