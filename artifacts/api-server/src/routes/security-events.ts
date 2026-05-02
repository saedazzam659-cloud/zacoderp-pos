import { Router } from "express";
import { db } from "@workspace/db";
import {
  securityEventsTable,
  securityEventMediaTable,
  securityNotificationRulesTable,
  SECURITY_EVENT_TYPES,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_STATUSES,
  branchesTable,
  usersTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, sql, inArray, ilike, or } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { runSecurityNotificationRules } from "../lib/securityNotifyOnEvent.js";

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

// Tenant-safe object-path validation. Any /objects/... path that gets
// stored on a security_events row MUST come from this tenant's own
// upload (recorded in security_event_media). Without this, a tenant
// could simply paste another tenant's path into create/update and
// then call /api/ai/security/analyze-image, which uses the row as
// proof of ownership. Returns the validated path, null for empty
// values, or throws "MEDIA_UNAUTHORIZED" on a foreign / unknown path.
async function validateOwnedMediaPath(cid: number, raw: unknown): Promise<string | null> {
  if (raw == null || raw === "") return null;
  const p = String(raw).trim();
  if (!p) return null;
  if (!p.startsWith("/objects/")) throw new Error("MEDIA_UNAUTHORIZED");
  const [row] = await db.select({ id: securityEventMediaTable.id })
    .from(securityEventMediaTable)
    .where(and(
      eq(securityEventMediaTable.companyId, cid),
      eq(securityEventMediaTable.objectPath, p),
    ))
    .limit(1);
  if (!row) throw new Error("MEDIA_UNAUTHORIZED");
  return p;
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
    // ── AI/ERP linkage filters ───────────────────────────────────────
    const linkedModule = String(req.query.linkedModule ?? "");
    const source       = String(req.query.source ?? "");
    if (linkedModule) conds.push(eq(securityEventsTable.linkedModule, linkedModule));
    if (source)       conds.push(eq(securityEventsTable.source, source));
    if (req.query.cameraId)        conds.push(eq(securityEventsTable.cameraId, Number(req.query.cameraId)));
    if (req.query.branchId)        conds.push(eq(securityEventsTable.branchId, Number(req.query.branchId)));
    if (req.query.employeeId)      conds.push(eq(securityEventsTable.employeeId, Number(req.query.employeeId)));
    if (req.query.productionLineId)conds.push(eq(securityEventsTable.productionLineId, Number(req.query.productionLineId)));
    if (req.query.warehouseId)     conds.push(eq(securityEventsTable.warehouseId, Number(req.query.warehouseId)));
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

// ── Notification Rules CRUD ─────────────────────────────────────────
// Mounted BEFORE the :id catch-alls so the literal `notification-rules`
// path is matched first by Express. Per-company rules that decide who
// gets notified when a security_events row is created.

function isMinSeverity(s: unknown): s is "low" | "medium" | "high" | "critical" {
  return s === "low" || s === "medium" || s === "high" || s === "critical";
}
function isTargetMode(s: unknown): s is "broadcast" | "users" {
  return s === "broadcast" || s === "users";
}
function sanitizeEventTypesArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && (SECURITY_EVENT_TYPES as readonly string[]).includes(v)) out.push(v);
  }
  return Array.from(new Set(out));
}
function sanitizeIntArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return Array.from(new Set(out));
}
async function validateBranchIdsForCompany(cid: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.companyId, cid), inArray(branchesTable.id, ids)));
  const valid = new Set(rows.map((r) => r.id));
  return ids.filter((id) => valid.has(id));
}
async function validateUserIdsForCompany(cid: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, cid), inArray(usersTable.id, ids)));
  const valid = new Set(rows.map((r) => r.id));
  return ids.filter((id) => valid.has(id));
}

// GET /notification-rules — list rules for the current company.
router.get("/notification-rules", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const rows = await db.select().from(securityNotificationRulesTable)
      .where(eq(securityNotificationRulesTable.companyId, cid))
      .orderBy(desc(securityNotificationRulesTable.createdAt));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "list failed" });
  }
});

// POST /notification-rules — create.
router.post("/notification-rules", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim().slice(0, 200);
    if (!name) { res.status(400).json({ error: "اسم القاعدة مطلوب" }); return; }
    const minSeverity = isMinSeverity(b.minSeverity) ? b.minSeverity : "medium";
    const targetMode = isTargetMode(b.targetMode) ? b.targetMode : "broadcast";
    const eventTypes = sanitizeEventTypesArray(b.eventTypes);
    const branchIds = await validateBranchIdsForCompany(cid, sanitizeIntArray(b.branchIds));
    const targetUserIds = targetMode === "users"
      ? await validateUserIdsForCompany(cid, sanitizeIntArray(b.targetUserIds))
      : [];
    if (targetMode === "users" && targetUserIds.length === 0) {
      res.status(400).json({ error: "يجب اختيار مستخدم واحد على الأقل عند الاستهداف الفردي" });
      return;
    }
    const isActive = b.isActive === false ? false : true;

    const [row] = await db.insert(securityNotificationRulesTable).values({
      companyId: cid,
      name,
      isActive,
      minSeverity,
      eventTypes,
      branchIds,
      targetMode,
      targetUserIds,
      createdByUserId: req.authUser?.id ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "create failed" });
  }
});

// PUT /notification-rules/:id — update.
router.put("/notification-rules/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const [existing] = await db.select().from(securityNotificationRulesTable)
      .where(and(
        eq(securityNotificationRulesTable.id, id),
        eq(securityNotificationRulesTable.companyId, cid),
      ));
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }

    const b = req.body ?? {};
    const updates: any = { updatedAt: new Date() };
    if (b.name !== undefined) {
      const n = String(b.name ?? "").trim().slice(0, 200);
      if (!n) { res.status(400).json({ error: "اسم القاعدة مطلوب" }); return; }
      updates.name = n;
    }
    if (b.isActive !== undefined) updates.isActive = !!b.isActive;
    if (b.minSeverity !== undefined) {
      if (!isMinSeverity(b.minSeverity)) { res.status(400).json({ error: "مستوى الخطورة غير صالح" }); return; }
      updates.minSeverity = b.minSeverity;
    }
    if (b.eventTypes !== undefined) updates.eventTypes = sanitizeEventTypesArray(b.eventTypes);
    if (b.branchIds !== undefined) {
      updates.branchIds = await validateBranchIdsForCompany(cid, sanitizeIntArray(b.branchIds));
    }
    const newMode = b.targetMode !== undefined
      ? (isTargetMode(b.targetMode) ? b.targetMode : existing.targetMode)
      : existing.targetMode;
    if (b.targetMode !== undefined) updates.targetMode = newMode;
    if (b.targetUserIds !== undefined || b.targetMode !== undefined) {
      if (newMode === "users") {
        const ids = await validateUserIdsForCompany(
          cid,
          sanitizeIntArray(b.targetUserIds ?? existing.targetUserIds),
        );
        if (ids.length === 0) {
          res.status(400).json({ error: "يجب اختيار مستخدم واحد على الأقل عند الاستهداف الفردي" });
          return;
        }
        updates.targetUserIds = ids;
      } else {
        updates.targetUserIds = [];
      }
    }

    const [row] = await db.update(securityNotificationRulesTable)
      .set(updates)
      .where(and(
        eq(securityNotificationRulesTable.id, id),
        eq(securityNotificationRulesTable.companyId, cid),
      ))
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "update failed" });
  }
});

// POST /notification-rules/:id/toggle — flip isActive.
router.post("/notification-rules/:id/toggle", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [existing] = await db.select().from(securityNotificationRulesTable)
      .where(and(
        eq(securityNotificationRulesTable.id, id),
        eq(securityNotificationRulesTable.companyId, cid),
      ));
    if (!existing) { res.status(404).json({ error: "غير موجود" }); return; }
    const [row] = await db.update(securityNotificationRulesTable)
      .set({ isActive: !existing.isActive, updatedAt: new Date() })
      .where(and(
        eq(securityNotificationRulesTable.id, id),
        eq(securityNotificationRulesTable.companyId, cid),
      ))
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "toggle failed" });
  }
});

// DELETE /notification-rules/:id
router.delete("/notification-rules/:id", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
    const result = await db.delete(securityNotificationRulesTable)
      .where(and(
        eq(securityNotificationRulesTable.id, id),
        eq(securityNotificationRulesTable.companyId, cid),
      ))
      .returning({ id: securityNotificationRulesTable.id });
    if (result.length === 0) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "delete failed" });
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

// ── POST /media/request-url  (scoped, ownership-tracked upload) ─────
// Issues a presigned upload URL AND records (companyId, userId,
// objectPath) into security_event_media so that downstream readers
// (the AI vision endpoint, the storage proxy) can verify the
// requester's company actually owns this object before serving or
// analyzing it. This is the authorization-binding layer that prevents
// one tenant from analyzing another tenant's image just by knowing
// its /objects/... path.
router.post("/media/request-url", async (req, res) => {
  try {
    const cid = guard(req, res);
    if (!cid) return;
    const userId = (req as any).authUser?.id ?? null;
    const kindRaw = String((req.body as any)?.kind ?? "image").toLowerCase();
    const kind = kindRaw === "video" ? "video" : "image";

    const svc = new ObjectStorageService();
    const uploadURL = await svc.getObjectEntityUploadURL();
    const objectPath = svc.normalizeObjectEntityPath(uploadURL);

    await db.insert(securityEventMediaTable).values({
      companyId: cid,
      userId,
      objectPath,
      kind,
    }).onConflictDoNothing();

    res.json({ uploadURL, objectPath, kind });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "request-url failed" });
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

    let imageUrlSafe: string | null;
    let videoClipUrlSafe: string | null;
    try {
      imageUrlSafe = await validateOwnedMediaPath(cid, b.imageUrl);
      videoClipUrlSafe = await validateOwnedMediaPath(cid, b.videoClipUrl);
    } catch {
      res.status(400).json({ error: "مرجع وسائط غير صالح: الصورة أو الفيديو لا ينتمي للشركة" });
      return;
    }

    // AI/ERP linkage — all optional plain ints; we only constrain the
    // discriminator strings to the documented vocabularies.
    const SRC = new Set(["camera", "ai", "user", "erp"]);
    const MOD = new Set(["hr", "production", "inventory", "branch", "none"]);
    const sourceVal       = SRC.has(String(b.source)) ? String(b.source) : "user";
    const linkedModuleVal = MOD.has(String(b.linkedModule)) ? String(b.linkedModule) : "none";
    const toNullInt = (v: any) => (v === "" || v === null || v === undefined) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

    const [row] = await db.insert(securityEventsTable).values({
      companyId: cid,
      branchId: branchIdSafe,
      cameraLabel: b.cameraLabel ? String(b.cameraLabel).slice(0, 200) : null,
      eventType,
      severity,
      status,
      title: title.slice(0, 300),
      description: b.description ? String(b.description) : null,
      imageUrl: imageUrlSafe,
      videoClipUrl: videoClipUrlSafe,
      confidence: clampConfidence(b.confidence),
      eventDateTime,
      assignedToUserId: assignedToUserIdSafe,
      createdByUserId: req.authUser?.id ?? null,
      resolvedAt,
      resolutionNote: b.resolutionNote ? String(b.resolutionNote) : null,
      source: sourceVal,
      cameraId: toNullInt(b.cameraId),
      linkedModule: linkedModuleVal,
      refId: toNullInt(b.refId),
      employeeId: toNullInt(b.employeeId),
      productionLineId: toNullInt(b.productionLineId),
      warehouseId: toNullInt(b.warehouseId),
      departmentId: toNullInt(b.departmentId),
      aiResult: b.aiResult ?? null,
      actionsTaken: b.actionsTaken ?? null,
    }).returning();

    // Fire-and-forget rule evaluation. The helper has its own
    // try/catch so it can never break event creation.
    if (row) {
      void runSecurityNotificationRules(cid, {
        id: row.id,
        eventType: row.eventType,
        severity: row.severity,
        title: row.title,
        branchId: row.branchId,
        cameraLabel: row.cameraLabel,
      }, req.authUser?.id ?? null);
    }

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
    if (b.imageUrl !== undefined) {
      try { updates.imageUrl = await validateOwnedMediaPath(cid, b.imageUrl); }
      catch { res.status(400).json({ error: "الصورة غير مرفوعة من هذه الشركة" }); return; }
    }
    if (b.videoClipUrl !== undefined) {
      try { updates.videoClipUrl = await validateOwnedMediaPath(cid, b.videoClipUrl); }
      catch { res.status(400).json({ error: "الفيديو غير مرفوع من هذه الشركة" }); return; }
    }
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
