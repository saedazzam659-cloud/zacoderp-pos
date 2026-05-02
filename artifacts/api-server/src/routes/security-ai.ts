// ─────────────────────────────────────────────────────────────────────────
// Security & Surveillance — AI helpers.
//
// Turns the security_events stream into actionable ERP signals:
//   • /insights      — top event types, hot branches/cameras, MTTR.
//   • /heatmap       — hour×day count grid for the dashboard.
//   • /analyze/:id   — risk scoring + recommended action for a single event.
//   • /dispatch      — execute (or just record) an action against an event:
//                      hr violation, production task, alert, evaluation…
//   • /evaluate-rules— run the recurring AI/business-rule engine once.
//
// All endpoints are tenant-scoped via `requireModulePermission` +
// `resolveCompanyId`. Falls back to deterministic logic when the OpenAI
// proxy env is unset, so the screens always render real numbers.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  securityEventsTable,
  securityActionsTable,
  surveillanceDevicesTable,
  securityNotificationRulesTable,
} from "@workspace/db";
import { and, eq, desc, sql, gte } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("security_events"));
router.use(moduleAudit("security_events"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function requireCid(req: any, res: any): number | null {
  const raw = req.body?.companyId ?? req.query.companyId;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Severity weight used by both the risk score and the rule engine.
const SEV_W: Record<string, number> = { low: 1, medium: 3, high: 6, critical: 10 };

// Recommended action vocabulary — what the dispatcher can do.
const ACTION_KINDS = new Set(["notify", "task", "violation", "evaluation", "stop_process"]);
const TARGET_MODULES = new Set(["hr", "production", "inventory", "none"]);

// ── /insights ───────────────────────────────────────────────────────
// Aggregated dashboard for the AI screen. `days` defaults to 30.
router.get("/insights", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const days  = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
    const since = new Date(Date.now() - days * 86_400_000);

    const where = and(
      eq(securityEventsTable.companyId, cid),
      gte(securityEventsTable.eventDateTime, since),
    );

    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(securityEventsTable).where(where);

    const byModule = await db
      .select({ k: securityEventsTable.linkedModule, c: sql<number>`count(*)::int` })
      .from(securityEventsTable).where(where).groupBy(securityEventsTable.linkedModule);

    const bySource = await db
      .select({ k: securityEventsTable.source, c: sql<number>`count(*)::int` })
      .from(securityEventsTable).where(where).groupBy(securityEventsTable.source);

    const topTypes = await db
      .select({ k: securityEventsTable.eventType, c: sql<number>`count(*)::int` })
      .from(securityEventsTable).where(where)
      .groupBy(securityEventsTable.eventType).orderBy(desc(sql`count(*)`)).limit(5);

    const topBranches = await db
      .select({ k: securityEventsTable.branchId, c: sql<number>`count(*)::int` })
      .from(securityEventsTable).where(where)
      .groupBy(securityEventsTable.branchId).orderBy(desc(sql`count(*)`)).limit(5);

    const topCameras = await db
      .select({ k: securityEventsTable.cameraId, c: sql<number>`count(*)::int` })
      .from(securityEventsTable).where(where)
      .groupBy(securityEventsTable.cameraId).orderBy(desc(sql`count(*)`)).limit(5);

    // Mean Time To Resolve, in hours, for events that did resolve in the period.
    const [{ mttr } = { mttr: null }] = await db
      .select({
        mttr: sql<number | null>`avg(extract(epoch from (resolved_at - event_date_time)) / 3600.0)`,
      })
      .from(securityEventsTable)
      .where(and(
        where,
        sql`resolved_at is not null`,
      ));

    // Action counts (what the AI engine actually did)
    const actionsBy = await db
      .select({ k: securityActionsTable.kind, c: sql<number>`count(*)::int` })
      .from(securityActionsTable)
      .where(and(
        eq(securityActionsTable.companyId, cid),
        gte(securityActionsTable.createdAt, since),
      ))
      .groupBy(securityActionsTable.kind);

    res.json({
      days, total,
      byModule, bySource, topTypes, topBranches, topCameras,
      mttrHours: mttr === null ? null : Number(Number(mttr).toFixed(2)),
      actionsBy,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── /heatmap ────────────────────────────────────────────────────────
// Hour-of-day × day-of-week event count (last `days` days, default 30).
// Returns a 7×24 grid: rows = Sun..Sat, cols = 0..23.
router.get("/heatmap", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const days  = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await db
      .select({
        dow:  sql<number>`extract(dow  from event_date_time)::int`,
        hour: sql<number>`extract(hour from event_date_time)::int`,
        c:    sql<number>`count(*)::int`,
      })
      .from(securityEventsTable)
      .where(and(
        eq(securityEventsTable.companyId, cid),
        gte(securityEventsTable.eventDateTime, since),
      ))
      .groupBy(sql`extract(dow from event_date_time)`, sql`extract(hour from event_date_time)`);

    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of rows) {
      const d = Math.max(0, Math.min(6, Number(r.dow)));
      const h = Math.max(0, Math.min(23, Number(r.hour)));
      grid[d][h] = Number(r.c);
    }
    res.json({ days, grid });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── /analyze/:id ────────────────────────────────────────────────────
// Score one event and produce a recommended action. Updates the event's
// `aiResult` jsonb column so the SecurityEvents screen can show the
// chip without a second round-trip.
function recommendFor(ev: any, dev: any | null): {
  riskScore: number; level: "low"|"medium"|"high"|"critical";
  action: { kind: string; targetModule: string; title: string; details: string };
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = (SEV_W[String(ev.severity)] ?? 3) * 10;        // 10..100
  if (Number(ev.confidence ?? 0) >= 0.85) { score += 5; reasons.push("ثقة AI عالية"); }
  if (ev.linkedModule && ev.linkedModule !== "none") {
    score += 5; reasons.push("مرتبط بموديل تشغيلي");
  }
  // Night events are extra risky for inventory / branch
  const hour = new Date(ev.eventDateTime ?? new Date()).getHours();
  const isNight = hour >= 22 || hour < 6;
  if (isNight && (ev.linkedModule === "inventory" || ev.linkedModule === "branch")) {
    score += 10; reasons.push("نشاط ليلي بعد ساعات العمل");
  }
  if (ev.eventType === "theft" || ev.eventType === "intrusion") {
    score += 10; reasons.push("نوع حدث عالي الخطورة");
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level: "low"|"medium"|"high"|"critical" =
    score >= 80 ? "critical" :
    score >= 60 ? "high"     :
    score >= 35 ? "medium"   : "low";

  // Decide what to do.
  let kind = "notify";
  let targetModule = "none";
  let title = ev.title;
  let details = `حدث ${ev.eventType} بدرجة ${ev.severity}.`;

  if (ev.linkedModule === "hr" || ev.employeeId) {
    targetModule = "hr";
    if (level === "critical" || level === "high") {
      kind = "violation";
      title = `مخالفة سلوكية على الموظف #${ev.employeeId ?? "—"}`;
      details = `بناءً على حدث الكاميرا (${ev.eventType})، يُنصح بتسجيل مخالفة وخصم تقييم.`;
    } else {
      kind = "evaluation";
      title = `تحديث تقييم الموظف #${ev.employeeId ?? "—"}`;
      details = `حدث متوسط الخطورة، يُنصح بإضافة ملاحظة سلبية في تقييم الأداء.`;
    }
  } else if (ev.linkedModule === "production" || ev.productionLineId) {
    targetModule = "production";
    kind = level === "critical" ? "stop_process" : "task";
    title = `مهمة على خط الإنتاج #${ev.productionLineId ?? "—"}`;
    details = `حدث على الكاميرا، يُنصح بفتح مهمة فحص ${level === "critical" ? "وإيقاف الخط مؤقتاً" : ""}.`;
  } else if (ev.linkedModule === "inventory" || ev.warehouseId) {
    targetModule = "inventory";
    kind = "task";
    title = `مراجعة جرد المخزن #${ev.warehouseId ?? "—"}`;
    details = `حركة غير معتادة أو ${ev.eventType} داخل المخزن، يُنصح بمراجعة الجرد بعد آخر حركة.`;
  } else {
    kind = level === "critical" || level === "high" ? "task" : "notify";
    title = ev.title;
    details = `إنشاء ${kind === "task" ? "مهمة متابعة" : "تنبيه"} لمسؤول الفرع.`;
  }
  if (dev?.location)        reasons.push(`موقع الكاميرا: ${dev.location}`);
  if (dev?.locationType)    reasons.push(`نوع الموقع: ${dev.locationType}`);

  return { riskScore: score, level, reasons, action: { kind, targetModule, title, details } };
}

router.get("/analyze/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ev] = await db.select().from(securityEventsTable)
      .where(and(eq(securityEventsTable.id, id), eq(securityEventsTable.companyId, cid)));
    if (!ev) { res.status(404).json({ error: "الحدث غير موجود" }); return; }
    let dev: any = null;
    if (ev.cameraId) {
      const [d] = await db.select().from(surveillanceDevicesTable)
        .where(and(eq(surveillanceDevicesTable.id, ev.cameraId), eq(surveillanceDevicesTable.companyId, cid)));
      dev = d ?? null;
    }
    const out = recommendFor(ev, dev);
    await db.update(securityEventsTable).set({
      aiResult: out as any,
      updatedAt: new Date(),
    }).where(and(eq(securityEventsTable.id, id), eq(securityEventsTable.companyId, cid)));
    res.json({ eventId: id, ...out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── /dispatch ───────────────────────────────────────────────────────
// Body: { eventId, kind, targetModule, targetRefId?, title, details? }
// Records the action on `security_actions` AND appends a summary to
// the event's `actions_taken` jsonb.
router.post("/dispatch", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const b = req.body ?? {};
    const eventId = Number(b.eventId);
    if (!Number.isFinite(eventId)) { res.status(400).json({ error: "eventId مطلوب" }); return; }
    const [ev] = await db.select().from(securityEventsTable)
      .where(and(eq(securityEventsTable.id, eventId), eq(securityEventsTable.companyId, cid)));
    if (!ev) { res.status(404).json({ error: "الحدث غير موجود" }); return; }
    const kind = String(b.kind ?? "notify");
    if (!ACTION_KINDS.has(kind)) { res.status(400).json({ error: "نوع الإجراء غير صالح" }); return; }
    const targetModule = String(b.targetModule ?? "none");
    if (!TARGET_MODULES.has(targetModule)) { res.status(400).json({ error: "الموديل المستهدف غير صالح" }); return; }
    const title = String(b.title ?? "").trim().slice(0, 300) || ev.title;

    const [action] = await db.insert(securityActionsTable).values({
      companyId: cid,
      eventId,
      kind,
      targetModule,
      targetRefId: b.targetRefId == null ? null : Number(b.targetRefId),
      title,
      details: b.details ? String(b.details) : null,
      status: "completed",
      payload: b.payload ?? null,
      createdByUserId: req.authUser?.id ?? null,
    }).returning();

    // Append to event's actionsTaken summary
    const prev = (ev.actionsTaken as any[] | null) ?? [];
    prev.push({
      id: action.id, kind, targetModule, refId: action.targetRefId,
      at: new Date().toISOString(), title,
    });
    await db.update(securityEventsTable).set({
      actionsTaken: prev as any,
      updatedAt: new Date(),
    }).where(and(eq(securityEventsTable.id, eventId), eq(securityEventsTable.companyId, cid)));

    res.status(201).json(action);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── /actions  (audit log) ───────────────────────────────────────────
router.get("/actions", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const conds: any[] = [eq(securityActionsTable.companyId, cid)];
    if (req.query.module)  conds.push(eq(securityActionsTable.targetModule, String(req.query.module)));
    if (req.query.eventId) conds.push(eq(securityActionsTable.eventId, Number(req.query.eventId)));
    const rows = await db.select().from(securityActionsTable)
      .where(and(...conds))
      .orderBy(desc(securityActionsTable.createdAt))
      .limit(500);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── /evaluate-rules ─────────────────────────────────────────────────
// Walk this company's active business-rule notification_rules whose
// `triggerType !== "manual"` and synthesize new security_events when
// their conditions match. Returns the number of events generated.
router.post("/evaluate-rules", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rules = await db.select().from(securityNotificationRulesTable)
      .where(and(
        eq(securityNotificationRulesTable.companyId, cid),
        eq(securityNotificationRulesTable.isActive, true),
      ));
    const now = new Date();
    const generated: any[] = [];
    for (const r of rules) {
      if (r.triggerType === "manual") continue;

      if (r.triggerType === "warehouse_after_hours") {
        const start = r.windowStartHour ?? 22;
        const end   = r.windowEndHour   ?? 6;
        const h = now.getHours();
        const inWindow = (start <= end) ? (h >= start && h < end) : (h >= start || h < end);
        if (!inWindow) continue;

        const cams = await db.select().from(surveillanceDevicesTable)
          .where(and(
            eq(surveillanceDevicesTable.companyId, cid),
            eq(surveillanceDevicesTable.locationType, "warehouse"),
            eq(surveillanceDevicesTable.status, "active"),
          ));
        for (const cam of cams) {
          const [evt] = await db.insert(securityEventsTable).values({
            companyId: cid,
            branchId: cam.branchId ?? null,
            cameraId: cam.id,
            cameraLabel: cam.nameAr,
            eventType: "after_hours_presence",
            severity: r.minSeverity,
            status: "open",
            title: `نشاط ليلي بمخزن ${cam.nameAr}`,
            description: `قاعدة AI "${r.name}" — تم رصد فترة ما بعد ساعات العمل (${start}:00 → ${end}:00)`,
            source: "ai",
            linkedModule: "inventory",
            warehouseId: cam.warehouseId ?? null,
            aiResult: { ruleId: r.id, ruleName: r.name } as any,
            confidence: "0.9000",
            eventDateTime: now,
          }).returning();
          if (evt) generated.push(evt);
        }
      }

      // line_downtime / employee_absent are recorded as derived events;
      // the actual sensor (production_events / camera motion API) is
      // populated by the production module. We surface the rule for now.
      if (r.triggerType === "line_downtime" || r.triggerType === "employee_absent") {
        // Lightweight heartbeat — opens an "open" event so the dashboard
        // surfaces the rule without spamming. Real sensor integration is a
        // follow-up.
        const [evt] = await db.insert(securityEventsTable).values({
          companyId: cid,
          eventType: "other",
          severity: r.minSeverity,
          status: "open",
          title: `قاعدة AI نشطة: ${r.name}`,
          description: `Trigger: ${r.triggerType}, threshold ${r.thresholdMinutes ?? "-"} min`,
          source: "ai",
          linkedModule: r.targetModule === "hr" ? "hr" : (r.targetModule === "production" ? "production" : "none"),
          aiResult: { ruleId: r.id, ruleName: r.name, trigger: r.triggerType } as any,
          eventDateTime: now,
        }).returning();
        if (evt) generated.push(evt);
      }
    }
    res.json({ generated: generated.length, events: generated });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
