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
//
// NOTE: Registered BEFORE `/:id` so a request for `/modules` doesn't get
// captured by the dynamic-id route (which would then 400 on the
// non-numeric "modules" param).
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

// Single-entry fetch — powers the shareable permalink (task #126). The
// audit-log page encodes the open dialog's row id in `?entry=N` so a URL
// like `/admin/audit-log?entry=12345` reopens the same details modal. When
// the entry isn't on the current filter page (or the page was loaded fresh
// from the link), the UI falls back to this endpoint to fetch it directly.
//
// Same tenant-scoping rules as the listing handler: superadmin can fetch
// any entry, every other admin is locked to their own company. We return
// 404 — not 403 — for cross-tenant ids so we don't leak whether a given id
// exists in some other company.
//
// Registered AFTER `/modules` so the static segment wins over `:id`.
router.get("/:id", async (req, res) => {
  try {
    const u = req.authUser!;
    const isSuper = u.role === "superadmin";
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }

    const conds: any[] = [eq(auditLogTable.id, id)];
    if (!isSuper) {
      // Non-superadmins are pinned to their own company. If they have no
      // company assigned at all (unusual but possible), fall through to a
      // condition that can never match so we return 404 cleanly instead of
      // exposing every entry.
      if (u.companyId != null) {
        conds.push(eq(auditLogTable.companyId, u.companyId));
      } else {
        res.status(404).json({ error: "السجل غير موجود" });
        return;
      }
    }

    const [row] = await db
      .select()
      .from(auditLogTable)
      .where(and(...conds))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "السجل غير موجود" });
      return;
    }
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "تعذر جلب السجل" });
  }
});

export default router;
