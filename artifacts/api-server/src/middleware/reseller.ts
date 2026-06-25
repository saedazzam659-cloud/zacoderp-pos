import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { resellersTable, resellerCompaniesTable, type Reseller, type ResellerPermissionKey } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────
// Reseller (Agent) auth + scoping — Task #237 (additive only).
//
// Resellers are a NEW identity type that lives in `resellers`, NOT `users`.
// They authenticate with their own bearer token (resellers.session_token) and
// every portal endpoint is scoped to the set of companies linked to that
// reseller. This middleware is mounted on the /api/reseller router which is
// registered BEFORE the path-less zatcaRouter so a reseller token (absent from
// usersTable) is never 401-ed by the global tenant-auth catch-all.
// ─────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      reseller?: Reseller;
    }
  }
}

export async function requireReseller(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.sessionToken, token));
  if (!reseller || !reseller.isActive) { res.status(401).json({ error: "الجلسة منتهية — يرجى تسجيل الدخول مجدداً" }); return; }
  if (reseller.status !== "active") { res.status(403).json({ error: "تم إيقاف حساب الموزّع — يرجى التواصل مع الإدارة" }); return; }
  req.reseller = reseller;
  next();
}

// True when the reseller has the given granular capability grant.
export function resellerCan(reseller: Reseller, key: ResellerPermissionKey): boolean {
  const perms = (reseller.permissions ?? {}) as Record<string, boolean>;
  return perms[key] === true;
}

// Middleware factory enforcing a single capability grant.
export function requireResellerPermission(key: ResellerPermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req.reseller;
    if (!r) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!resellerCan(r, key)) { res.status(403).json({ error: "ليس لديك صلاحية لهذا الإجراء" }); return; }
    next();
  };
}

// The set of company ids this reseller manages. Used to scope EVERY portal
// read/write so a reseller can never see or touch another reseller's clients.
export async function resellerCompanyIds(resellerId: number): Promise<number[]> {
  const rows = await db
    .select({ companyId: resellerCompaniesTable.companyId })
    .from(resellerCompaniesTable)
    .where(eq(resellerCompaniesTable.resellerId, resellerId));
  return rows.map((r) => r.companyId);
}

// True when `companyId` belongs to this reseller (ownership guard for by-id
// routes). Always re-check at write time — never trust a client-supplied id.
export async function resellerOwnsCompany(resellerId: number, companyId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: resellerCompaniesTable.id })
    .from(resellerCompaniesTable)
    .where(and(eq(resellerCompaniesTable.resellerId, resellerId), eq(resellerCompaniesTable.companyId, companyId)));
  return !!row;
}
