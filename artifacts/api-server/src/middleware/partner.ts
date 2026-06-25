import { type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { platformPartnersTable, partnerCompaniesTable, type PlatformPartner, type PartnerPermissionKey } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────
// Developer / Partner portal auth + scoping (additive only).
//
// Partners are a platform-level identity living in `platform_partners`, NOT
// `users`. They authenticate with their own bearer token
// (platform_partners.session_token) and every portal endpoint is scoped to the
// set of companies linked to that partner. This middleware is mounted on the
// /api/partner router which is registered BEFORE the path-less zatcaRouter so a
// partner token (absent from usersTable) is never 401-ed by the global
// tenant-auth catch-all. Mirrors `middleware/reseller.ts`.
//
// A partner may only authenticate once the head office has APPROVED it
// (status==="approved") and provisioned credentials — anything earlier in the
// onboarding flow has no portal access.
// ─────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      partner?: PlatformPartner;
    }
  }
}

export async function requirePartner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ error: "غير مصرح" }); return; }
  const token = auth.slice(7);
  const [partner] = await db.select().from(platformPartnersTable).where(eq(platformPartnersTable.sessionToken, token));
  if (!partner || !partner.isActive) { res.status(401).json({ error: "الجلسة منتهية — يرجى تسجيل الدخول مجدداً" }); return; }
  if (partner.status !== "approved") { res.status(403).json({ error: "تم إيقاف حساب الشريك — يرجى التواصل مع الإدارة" }); return; }
  req.partner = partner;
  next();
}

// True when the partner has the given granular capability grant.
export function partnerCan(partner: PlatformPartner, key: PartnerPermissionKey): boolean {
  const perms = (partner.permissions ?? {}) as Record<string, boolean>;
  return perms[key] === true;
}

// Middleware factory enforcing a single capability grant.
export function requirePartnerPermission(key: PartnerPermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.partner;
    if (!p) { res.status(401).json({ error: "غير مصرح" }); return; }
    if (!partnerCan(p, key)) { res.status(403).json({ error: "ليس لديك صلاحية لهذا الإجراء" }); return; }
    next();
  };
}

// The set of company ids this partner is linked to. Used to scope EVERY portal
// read so a partner can never see another partner's companies.
export async function partnerCompanyIds(partnerId: number): Promise<number[]> {
  const rows = await db
    .select({ companyId: partnerCompaniesTable.companyId })
    .from(partnerCompaniesTable)
    .where(eq(partnerCompaniesTable.partnerId, partnerId));
  return rows.map((r) => r.companyId);
}

// True when `companyId` belongs to this partner (ownership guard for by-id
// routes). Always re-check at read/write time — never trust a client-supplied id.
export async function partnerOwnsCompany(partnerId: number, companyId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: partnerCompaniesTable.id })
    .from(partnerCompaniesTable)
    .where(and(eq(partnerCompaniesTable.partnerId, partnerId), eq(partnerCompaniesTable.companyId, companyId)));
  return !!row;
}
