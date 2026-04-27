// Work-sessions router. A "work session" represents one user's login window
// (login → logout). Each session can be enriched on demand with an AI report
// summarising every recorded action that happened during the window.
//
// Endpoints (all scoped to the caller's companyId):
//   GET    /                  — list sessions (paginated, filterable)
//   GET    /summary           — quick stats (active count, today, this month)
//   GET    /:id               — one session, with activity preview
//   POST   /:id/end           — manually end an active session
//   POST   /:id/generate-report — collect activity and ask Anthropic to
//                                summarise it; persists the result.
//
// Permission model:
//   - Admins (role = "admin" / "superadmin") see every user in the company.
//   - Regular users only see (and can act on) their own sessions.
//
// We rely on the existing centralised `audit_log` table as the source of
// truth for "what did the user actually do during this window?" — that table
// already records every authenticated mutation alongside userId/companyId/
// module/action/entityType/entityId/metadata. No separate scrape of every
// financial table is needed; if a future feature is missing from audit_log,
// the fix is to make sure that feature writes through `writeAudit`, not to
// hand-roll another collector here.

import { Router } from "express";
import { db } from "@workspace/db";
import { workSessionsTable, auditLogTable, branchesTable } from "@workspace/db";
import { and, eq, desc, gte, lte, ne, count, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import {
  generateSessionReport,
  loadSessionSettings,
  runEndOfSessionHooks,
} from "../lib/workSessionReport.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// Helpers ---------------------------------------------------------------------

function getCid(req: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query?.companyId);
  return cid ?? null;
}

function isAdmin(req: any): boolean {
  const role = req.authUser?.role;
  return role === "admin" || role === "superadmin";
}

// NOTE: redactMetadata + the prompt + the Anthropic call all live in
// `lib/workSessionReport.ts` now so the auto-on-end hook (fired from
// /end and from the logout audit hook) can reuse the exact same logic
// without HTTP-bouncing through this router.

// Format a duration in seconds to "Xh Ym" (Arabic).
function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h && m) return `${h}س ${m}د`;
  if (h)      return `${h}س`;
  return `${m}د`;
}

// GET / -----------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const limit  = Math.min(200, Math.max(1, Number(req.query.limit  ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const status = (req.query.status as string | undefined) ?? null;

    // Non-admins are scoped to their own rows.
    const adminMode = isAdmin(req);
    const userScopeFilter = adminMode
      ? undefined
      : eq(workSessionsTable.userId, (req as any).authUser.id);

    const whereExpr = and(
      eq(workSessionsTable.companyId, cid),
      status ? eq(workSessionsTable.status, status) : undefined,
      userScopeFilter,
    );

    const rows = await db.select().from(workSessionsTable)
      .where(whereExpr)
      .orderBy(desc(workSessionsTable.startedAt))
      .limit(limit).offset(offset);

    // Resolve every distinct branchId on the page to its display name in
    // a single round-trip so the table can show "الفرع" without an N+1.
    const branchIds = Array.from(new Set(rows.map(r => r.branchId).filter((v): v is number => !!v)));
    const branchMap = new Map<number, { nameAr: string; nameEn: string | null; code: string }>();
    if (branchIds.length) {
      const brs = await db.select({
        id: branchesTable.id,
        nameAr: branchesTable.nameAr,
        nameEn: branchesTable.nameEn,
        code:   branchesTable.code,
      }).from(branchesTable).where(inArray(branchesTable.id, branchIds));
      for (const b of brs) branchMap.set(b.id, { nameAr: b.nameAr, nameEn: b.nameEn, code: b.code });
    }
    const enriched = rows.map(r => ({
      ...r,
      branchName: r.branchId ? (branchMap.get(r.branchId)?.nameAr ?? branchMap.get(r.branchId)?.nameEn ?? null) : null,
      branchCode: r.branchId ? (branchMap.get(r.branchId)?.code ?? null) : null,
    }));

    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /summary ---------------------------------------------------------------
router.get("/summary", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }

    const adminMode = isAdmin(req);
    const userScopeFilter = adminMode
      ? undefined
      : eq(workSessionsTable.userId, (req as any).authUser.id);

    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [active] = await db.select({ c: count() }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.companyId, cid),
        eq(workSessionsTable.status, "active"),
        userScopeFilter,
      ));
    const [today] = await db.select({ c: count() }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.companyId, cid),
        gte(workSessionsTable.startedAt, startOfToday),
        userScopeFilter,
      ));
    const [month] = await db.select({ c: count() }).from(workSessionsTable)
      .where(and(
        eq(workSessionsTable.companyId, cid),
        gte(workSessionsTable.startedAt, startOfMonth),
        userScopeFilter,
      ));

    res.json({
      active: Number(active?.c ?? 0),
      today:  Number(today?.c  ?? 0),
      month:  Number(month?.c  ?? 0),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id --------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }

    // Permission: non-admins can only view their own rows.
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }

    // Resolve branch label for display.
    let branchName: string | null = null;
    let branchCode: string | null = null;
    if (row.branchId) {
      const [b] = await db.select({ nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn, code: branchesTable.code })
        .from(branchesTable).where(eq(branchesTable.id, row.branchId)).limit(1);
      if (b) { branchName = b.nameAr || b.nameEn || null; branchCode = b.code; }
    }

    // Activity preview: pull the audit_log rows for this user/company that
    // fall inside the session window. Skip "view" rows — they're noise.
    const winEnd = row.endedAt ?? new Date();
    const activity = await db.select({
      id:         auditLogTable.id,
      module:     auditLogTable.module,
      action:     auditLogTable.action,
      entityType: auditLogTable.entityType,
      entityId:   auditLogTable.entityId,
      method:     auditLogTable.method,
      path:       auditLogTable.path,
      statusCode: auditLogTable.statusCode,
      metadata:   auditLogTable.metadata,
      createdAt:  auditLogTable.createdAt,
    }).from(auditLogTable)
      .where(and(
        eq(auditLogTable.userId, row.userId),
        eq(auditLogTable.companyId, cid),
        gte(auditLogTable.createdAt, row.startedAt),
        lte(auditLogTable.createdAt, winEnd),
        ne(auditLogTable.action, "view"),
      ))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(500);

    const durationSecs = Math.max(0, Math.floor(
      ((row.endedAt ?? new Date()).getTime() - row.startedAt.getTime()) / 1000));

    res.json({
      session: { ...row, branchName, branchCode },
      durationSecs,
      durationLabel: fmtDuration(durationSecs),
      activity,
      activityCount: activity.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id/branch — set or clear the branch for a session.
//
// Body: { branchId: number | null }
// Permission: admin can set on any row; regular users only on their own rows.
// We re-validate the branch belongs to the caller's company so an admin can't
// pin a foreign branch.
router.patch("/:id/branch", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }

    const raw = req.body?.branchId;
    let branchId: number | null = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n)) { res.status(400).json({ error: "معرّف فرع غير صالح" }); return; }
      const [b] = await db.select({ id: branchesTable.id })
        .from(branchesTable)
        .where(and(eq(branchesTable.id, n), eq(branchesTable.companyId, cid)))
        .limit(1);
      if (!b) { res.status(400).json({ error: "الفرع لا يخص هذه الشركة" }); return; }
      branchId = n;
    }

    await db.update(workSessionsTable)
      .set({ branchId, updatedAt: new Date() })
      .where(eq(workSessionsTable.id, id));

    const [updated] = await db.select().from(workSessionsTable)
      .where(eq(workSessionsTable.id, id)).limit(1);
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/end ---------------------------------------------------------------
router.post("/:id/end", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }
    if (row.status !== "active") {
      res.status(400).json({ error: "الجلسة منتهية بالفعل" }); return;
    }

    await db.update(workSessionsTable).set({
      status:    "ended",
      endedAt:   new Date(),
      endReason: "manual",
      updatedAt: new Date(),
    }).where(eq(workSessionsTable.id, id));

    const [updated] = await db.select().from(workSessionsTable)
      .where(eq(workSessionsTable.id, id)).limit(1);

    // Fire end-of-session hooks (auto-generate report + auto-email) in the
    // background. These are best-effort — failures are logged inside the
    // helper and never bubble up here so the manual end click still
    // returns 200 immediately.
    void runEndOfSessionHooks(id, cid, { reason: "manual" });

    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/generate-report ---------------------------------------------------
//
// Thin wrapper around the shared `generateSessionReport()` helper. The same
// helper is also called from the end-of-session hook so manual generation
// and auto-on-end produce the exact same Markdown.
router.post("/:id/generate-report", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

    // Permission check before doing any work — load the row first.
    const [row] = await db.select().from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, id), eq(workSessionsTable.companyId, cid)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "الجلسة غير موجودة" }); return; }
    if (!isAdmin(req) && row.userId !== (req as any).authUser.id) {
      res.status(403).json({ error: "ممنوع" }); return;
    }

    // Pick the model from the per-company settings so admins can dial cost
    // vs. quality without code changes. `force=true` so a manual click
    // refreshes the cached report (the auto-on-end hook uses force=false).
    const settings = await loadSessionSettings(cid);
    const result = await generateSessionReport(id, cid, {
      model: settings.aiModel,
      force: true,
    });

    if (!result.ok) {
      const reason = result.reason;
      if (reason === "anthropic_not_configured") {
        res.status(503).json({ error: "خدمة الذكاء الاصطناعي غير مهيّأة على الخادم." });
      } else if (reason === "session_not_found") {
        res.status(404).json({ error: "الجلسة غير موجودة" });
      } else {
        res.status(500).json({ error: "تعذّر توليد التقرير" });
      }
      return;
    }

    res.json({
      ok: true,
      aiReport: result.aiReport,
      aiReportGeneratedAt: new Date().toISOString(),
      activityCount: result.activityCount,
      truncated: result.truncated ?? false,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "تعذّر توليد التقرير" });
  }
});

// Suppress unused-import warnings for `sql` and the audit-log helpers — these
// stay imported because the GET / and GET /:id activity preview block still
// uses gte/lte/ne/desc/auditLogTable. `sql` is kept for future date filters.
void sql;

export default router;
