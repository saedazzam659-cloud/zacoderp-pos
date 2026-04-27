import { Router } from "express";
import { db } from "@workspace/db";
import {
  securityEventsTable,
  SECURITY_EVENT_TYPES,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_STATUSES,
  branchesTable,
  usersTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, sql, inArray, ilike, or } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("security_events"));
router.use(moduleAudit("security_events"));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return cid;
}

// ── Helpers ─────────────────────────────────────────────────────────
function isStatus(s: unknown): s is (typeof SECURITY_EVENT_STATUSES)[number] {
  return typeof s === "string" && (SECURITY_EVENT_STATUSES as readonly string[]).includes(s);
}
function isType(s: unknown): s is (typeof SECURITY_EVENT_TYPES)[number] {
  return typeof s === "string" && (SECURITY_EVENT_TYPES as readonly string[]).includes(s);
}
function isSeverity(s: unknown): s is (typeof SECURITY_EVENT_SEVERITIES)[number] {
  return typeof s === "string" && (SECURITY_EVENT_SEVERITIES as readonly string[]).includes(s);
}
function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}
function clampConfidence(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const c = Math.max(0, Math.min(1, n));
  return c.toFixed(4);
}

// Tenant-safe FK validation. Returns the validated id, or null when the FK
// is null/undefined, or throws "FK_INVALID" when the referenced row does not
// belong to the same company. Call sites translate that into a 400.
async function validateBranchFk(cid: number, raw: unknown): Promise<number | null> {
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) throw new Error("FK_INVALID");
  const [row] = await db.select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.id, id), eq(branchesTable.companyId, cid)))
    .limit(1);
  if (!row) throw new Error("FK_INVALID");
  return id;
}
async function validateUserFk(cid: number, raw: unknown): Promise<number | null> {
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) throw new Error("FK_INVALID");
  const [row] = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.id, id), eq(usersTable.companyId, cid)))
    .limit(1);
  if (!row) throw new Error("FK_INVALID");
  return id;
}

// ── GET /summary  (aggregates for hub dashboard) ────────────────────
router.get("/summary", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;

    const fromQ = parseDate(req.query.from);
    const toQ   = parseDate(req.query.to);
    const from  = fromQ ?? new Date(Date.now() - 7 * 86400_000);
    const to    = toQ   ?? new Date();

    const where = and(
      eq(securityEventsTable.companyId, cid),
      gte(securityEventsTable.eventDateTime, from),
      lte(securityEventsTable.eventDateTime, to),
    );

    const totalsRows = await db
      .select({ status: securityEventsTable.status, count: sql<number>`count(*)::int` })
      .from(securityEventsTable)
      .where(where)
      .groupBy(securityEventsTable.status);
    const totals = { open: 0, investigating: 0, closed: 0, falsePositive: 0, total: 0 };
    for (const r of totalsRows) {
      const c = Number(r.count) || 0;
      totals.total += c;
      if (r.status === "open") totals.open += c;
      else if (r.status === "investigating") totals.investigating += c;
      else if (r.status === "closed") totals.closed += c;
      else if (r.status === "false_positive") totals.falsePositive += c;
    }

    const byType = await db
      .select({ type: securityEventsTable.eventType, count: sql<number>`count(*)::int` })
      .from(securityEventsTable)
      .where(where)
      .groupBy(securityEventsTable.eventType)
      .orderBy(desc(sql`count(*)`));

    const bySeverity = await db
      .select({ severity: securityEventsTable.severity, count: sql<number>`count(*)::int` })
      .from(securityEventsTable)
      .where(where)
      .groupBy(securityEventsTable.severity);

    // Last 7 days (date-bucketed). Always returns 7 rows even if zero events on a day.
    const last7Rows = await db
      .select({
        date: sql<string>`to_char(${securityEventsTable.eventDateTime}::date, 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(securityEventsTable)
      .where(and(
        eq(securityEventsTable.companyId, cid),
        gte(securityEventsTable.eventDateTime, new Date(Date.now() - 7 * 86400_000)),
      ))
      .groupBy(sql`${securityEventsTable.eventDateTime}::date`);
    const counts = new Map(last7Rows.map(r => [r.date, Number(r.count) || 0]));
    const last7Days: Array<{ date: string; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000);
      const iso = d.toISOString().slice(0, 10);
      last7Days.push({ date: iso, count: counts.get(iso) ?? 0 });
    }

    res.json({ totals, byType, bySeverity, last7Days });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "summary failed" });
  }
});

// ── GET /  (list with filters) ──────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;

    const conds: any[] = [eq(securityEventsTable.companyId, cid)];
    const status   = String(req.query.status   ?? "");
    const type     = String(req.query.type     ?? "");
    const severity = String(req.query.severity ?? "");
    const search   = String(req.query.search   ?? "").trim();
    const from     = parseDate(req.query.from);
    const to       = parseDate(req.query.to);

    if (isStatus(status))     conds.push(eq(securityEventsTable.status, status));
    if (isType(type))         conds.push(eq(securityEventsTable.eventType, type));
    if (isSeverity(severity)) conds.push(eq(securityEventsTable.severity, severity));
    if (from) conds.push(gte(securityEventsTable.eventDateTime, from));
    if (to)   conds.push(lte(securityEventsTable.eventDateTime, to));
    if (search) {
      conds.push(or(
        ilike(securityEventsTable.title, `%${search}%`),
        ilike(securityEventsTable.description, `%${search}%`),
        ilike(securityEventsTable.cameraLabel, `%${search}%`),
      )!);
    }

    const limitN = Math.max(1, Math.min(500, Number(req.query.limit ?? 200)));
    const rows = await db
      .select()
      .from(securityEventsTable)
      .where(and(...conds))
      .orderBy(desc(securityEventsTable.eventDateTime))
      .limit(limitN);

    // Batch enrichment — username + branch name for display, no N+1 queries.
    const userIds = Array.from(new Set(
      rows.flatMap(r => [r.assignedToUserId, r.createdByUserId]).filter((x): x is number => typeof x === "number"),
    ));
    const branchIds = Array.from(new Set(
      rows.map(r => r.branchId).filter((x): x is number => typeof x === "number"),
    ));
    // SECURITY: scope enrichment to the same tenant — never leak names of
    // users/branches belonging to other companies even if a stale or
    // cross-tenant FK ever sneaks into a row.
    const users = userIds.length
      ? await db.select({ id: usersTable.id, username: usersTable.username })
          .from(usersTable)
          .where(and(inArray(usersTable.id, userIds), eq(usersTable.companyId, cid)))
      : [];
    const branches = branchIds.length
      ? await db.select({ id: branchesTable.id, nameAr: branchesTable.nameAr })
          .from(branchesTable)
          .where(and(inArray(branchesTable.id, branchIds), eq(branchesTable.companyId, cid)))
      : [];
    const userMap = new Map(users.map(u => [u.id, u.username]));
    const branchMap = new Map(branches.map(b => [b.id, b.nameAr]));

    res.json(rows.map(r => ({
      ...r,
      assignedToUsername: r.assignedToUserId ? userMap.get(r.assignedToUserId) ?? null : null,
      createdByUsername: r.createdByUserId  ? userMap.get(r.createdByUserId)  ?? null : null,
      branchName: r.branchId ? branchMap.get(r.branchId) ?? null : null,
    })));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "list failed" });
  }
});

// ── GET /:id ────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [row] = await db.select().from(securityEventsTable)
      .where(and(eq(securityEventsTable.id, id), eq(securityEventsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "get failed" });
  }
});

// ── POST /  (create) ────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const eventType = isType(b.eventType) ? b.eventType : null;
    const severity  = isSeverity(b.severity) ? b.severity : "medium";
    const status    = isStatus(b.status) ? b.status : "open";
    const title     = String(b.title ?? "").trim();
    if (!eventType) { res.status(400).json({ error: "نوع الحدث غير صالح" }); return; }
    if (!title)     { res.status(400).json({ error: "العنوان مطلوب" }); return; }

    const eventDateTime = parseDate(b.eventDateTime) ?? new Date();
    const resolvedAt = (status === "closed" || status === "false_positive") ? new Date() : null;

    let branchIdSafe: number | null;
    let assignedToUserIdSafe: number | null;
    try {
      branchIdSafe = await validateBranchFk(cid, b.branchId);
      assignedToUserIdSafe = await validateUserFk(cid, b.assignedToUserId);
    } catch {
      res.status(400).json({ error: "مرجع غير صالح: الفرع أو المستخدم لا ينتمي للشركة" });
      return;
    }

    const [row] = await db.insert(securityEventsTable).values({
      companyId: cid,
      branchId: branchIdSafe,
      cameraLabel: b.cameraLabel ? String(b.cameraLabel).slice(0, 200) : null,
      eventType,
      severity,
      status,
      title: title.slice(0, 300),
      description: b.description ? String(b.description) : null,
      imageUrl: b.imageUrl ? String(b.imageUrl) : null,
      videoClipUrl: b.videoClipUrl ? String(b.videoClipUrl) : null,
      confidence: clampConfidence(b.confidence),
      eventDateTime,
      assignedToUserId: assignedToUserIdSafe,
      createdByUserId: req.authUser?.id ?? null,
      resolvedAt,
      resolutionNote: b.resolutionNote ? String(b.resolutionNote) : null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "create failed" });
  }
});

// ── PUT /:id ────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const [existing] = await db.select().from(securityEventsTable)
      .where(and(eq(securityEventsTable.id, id), eq(securityEventsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }

    const b = req.body ?? {};
    const updates: any = { updatedAt: new Date() };

    if (b.eventType !== undefined) {
      if (!isType(b.eventType)) { res.status(400).json({ error: "نوع الحدث غير صالح" }); return; }
      updates.eventType = b.eventType;
    }
    if (b.severity !== undefined) {
      if (!isSeverity(b.severity)) { res.status(400).json({ error: "مستوى الخطورة غير صالح" }); return; }
      updates.severity = b.severity;
    }
    if (b.status !== undefined) {
      if (!isStatus(b.status)) { res.status(400).json({ error: "الحالة غير صالحة" }); return; }
      updates.status = b.status;
      // Auto-stamp resolvedAt: closed/false_positive → now; reopen → clear.
      const wasResolved = existing.status === "closed" || existing.status === "false_positive";
      const nowResolved = b.status === "closed" || b.status === "false_positive";
      if (nowResolved && !wasResolved) updates.resolvedAt = new Date();
      if (!nowResolved && wasResolved) updates.resolvedAt = null;
    }
    if (b.title !== undefined)         updates.title = String(b.title).trim().slice(0, 300);
    if (b.description !== undefined)   updates.description = b.description ? String(b.description) : null;
    if (b.cameraLabel !== undefined)   updates.cameraLabel = b.cameraLabel ? String(b.cameraLabel).slice(0, 200) : null;
    if (b.branchId !== undefined) {
      try { updates.branchId = await validateBranchFk(cid, b.branchId); }
      catch { res.status(400).json({ error: "الفرع غير صالح أو لا ينتمي للشركة" }); return; }
    }
    if (b.assignedToUserId !== undefined) {
      try { updates.assignedToUserId = await validateUserFk(cid, b.assignedToUserId); }
      catch { res.status(400).json({ error: "المستخدم غير صالح أو لا ينتمي للشركة" }); return; }
    }
    if (b.imageUrl !== undefined)      updates.imageUrl = b.imageUrl ? String(b.imageUrl) : null;
    if (b.videoClipUrl !== undefined)  updates.videoClipUrl = b.videoClipUrl ? String(b.videoClipUrl) : null;
    if (b.confidence !== undefined)    updates.confidence = clampConfidence(b.confidence);
    if (b.resolutionNote !== undefined) updates.resolutionNote = b.resolutionNote ? String(b.resolutionNote) : null;
    if (b.eventDateTime !== undefined) {
      const d = parseDate(b.eventDateTime);
      if (d) updates.eventDateTime = d;
    }

    const [row] = await db.update(securityEventsTable)
      .set(updates)
      .where(and(eq(securityEventsTable.id, id), eq(securityEventsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "update failed" });
  }
});

// ── DELETE /:id ────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
    const result = await db.delete(securityEventsTable)
      .where(and(eq(securityEventsTable.id, id), eq(securityEventsTable.companyId, cid)))
      .returning({ id: securityEventsTable.id });
    if (!result.length) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "delete failed" });
  }
});

export default router;
