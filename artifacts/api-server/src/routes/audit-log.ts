import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogTable } from "@workspace/db";
import { and, eq, gte, lte, desc, sql, like } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/permissions.js";

// ─── Audit log viewer API ─────────────────────────────────────────────────
//   GET /api/audit-log
//     ?companyId   superadmin only — defaults to admin's own companyId
//     ?userId      filter to a single user (numeric)
//     ?module      e.g. "sales_invoices"
//     ?action      view | create | edit | delete | post | export | denied
//     ?from, ?to   ISO date strings (inclusive)
//     ?q           free text against username/path
//     ?limit       default 50, max 200
//     ?offset      default 0
//
//   Returns: { rows: AuditLogRow[], total: number, limit, offset }
// ──────────────────────────────────────────────────────────────────────────

const router = Router();
router.use(extractAuth);
router.use(requireAdminRole);   // admin or superadmin only

router.get("/", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";

    // Tenant scoping: superadmin may pass ?companyId (or omit for ALL),
    // every other admin is locked to their own company.
    const cid = isSuper
      ? resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined)
      : (u.companyId ?? undefined);

    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const mod    = typeof req.query.module === "string" ? req.query.module.slice(0, 80) : undefined;
    const act    = typeof req.query.action === "string" ? req.query.action.slice(0, 32) : undefined;
    const from   = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to     = typeof req.query.to   === "string" ? new Date(req.query.to)   : undefined;
    const q      = typeof req.query.q    === "string" ? req.query.q.trim().slice(0, 80) : "";
    const limit  = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    const conds: any[] = [];
    if (cid != null && Number.isFinite(cid))   conds.push(eq(auditLogTable.companyId, cid));
    if (userId && Number.isFinite(userId))     conds.push(eq(auditLogTable.userId,    userId));
    if (mod)                                   conds.push(eq(auditLogTable.module,    mod));
    if (act)                                   conds.push(eq(auditLogTable.action,    act));
    if (from && !isNaN(from.getTime()))        conds.push(gte(auditLogTable.createdAt, from));
    if (to   && !isNaN(to.getTime()))          conds.push(lte(auditLogTable.createdAt, to));
    if (q) {
      const pat = `%${q}%`;
      conds.push(
        sql`(${auditLogTable.username} ILIKE ${pat} OR ${auditLogTable.path} ILIKE ${pat})`
      );
    }
    const where = conds.length ? and(...conds) : undefined;

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable)
      .where(where as any);

    const rows = await db
      .select()
      .from(auditLogTable)
      .where(where as any)
      .orderBy(desc(auditLogTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ rows, total: Number(count ?? 0), limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب سجل النشاط" });
  }
});

// Distinct module list — used by the filter dropdown so the UI doesn't have
// to hardcode the catalogue. Cheap because the index covers it.
router.get("/modules", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";
    const cid = isSuper
      ? resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined)
      : (u.companyId ?? undefined);
    const where = cid != null ? eq(auditLogTable.companyId, cid) : undefined;
    const rows = await db
      .selectDistinct({ module: auditLogTable.module })
      .from(auditLogTable)
      .where(where as any)
      .orderBy(auditLogTable.module);
    res.json(rows.map(r => r.module).filter(Boolean));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب القائمة" });
  }
});

export default router;
