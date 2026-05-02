// ─────────────────────────────────────────────────────────────────────────
// Security & Surveillance — cross-module reports.
//   /reports/hr-compliance       — events per employee
//   /reports/production-downtime — events per production line
//   /reports/warehouse-night     — after-hours warehouse activity
//   /reports/branch-comparison   — events / actions per branch
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  securityEventsTable,
  securityActionsTable,
  surveillanceDevicesTable,
} from "@workspace/db";
import { and, eq, desc, gte, sql, isNotNull } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("security_events"));
router.use(moduleAudit("security_events"));

function requireCid(req: any, res: any): number | null {
  const raw = req.body?.companyId ?? req.query.companyId;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function sinceFromDays(req: any): Date {
  const days = Math.min(180, Math.max(1, Number(req.query.days ?? 30)));
  return new Date(Date.now() - days * 86_400_000);
}

router.get("/hr-compliance", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const since = sinceFromDays(req);
    const rows = await db.select({
      employeeId: securityEventsTable.employeeId,
      total:    sql<number>`count(*)::int`,
      open:     sql<number>`sum(case when ${securityEventsTable.status} = 'open' then 1 else 0 end)::int`,
      critical: sql<number>`sum(case when ${securityEventsTable.severity} = 'critical' then 1 else 0 end)::int`,
      high:     sql<number>`sum(case when ${securityEventsTable.severity} = 'high' then 1 else 0 end)::int`,
      lastAt:   sql<string | null>`to_char(max(${securityEventsTable.eventDateTime}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
    })
      .from(securityEventsTable)
      .where(and(
        eq(securityEventsTable.companyId, cid),
        gte(securityEventsTable.eventDateTime, since),
        isNotNull(securityEventsTable.employeeId),
      ))
      .groupBy(securityEventsTable.employeeId)
      .orderBy(desc(sql`count(*)`))
      .limit(100);
    res.json({ since, items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/production-downtime", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const since = sinceFromDays(req);
    const rows = await db.select({
      productionLineId: securityEventsTable.productionLineId,
      total:    sql<number>`count(*)::int`,
      open:     sql<number>`sum(case when ${securityEventsTable.status} = 'open' then 1 else 0 end)::int`,
      stops:    sql<number>`sum(case when ${securityEventsTable.eventType} in ('tampering','other') then 1 else 0 end)::int`,
      lastAt:   sql<string | null>`to_char(max(${securityEventsTable.eventDateTime}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
    })
      .from(securityEventsTable)
      .where(and(
        eq(securityEventsTable.companyId, cid),
        gte(securityEventsTable.eventDateTime, since),
        isNotNull(securityEventsTable.productionLineId),
      ))
      .groupBy(securityEventsTable.productionLineId)
      .orderBy(desc(sql`count(*)`))
      .limit(100);
    res.json({ since, items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/warehouse-night", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const since = sinceFromDays(req);
    // Default night window 22:00..06:00 (configurable via query).
    const startH = Math.min(23, Math.max(0, Number(req.query.startHour ?? 22)));
    const endH   = Math.min(23, Math.max(0, Number(req.query.endHour   ?? 6)));
    const hourClause = startH <= endH
      ? sql`extract(hour from event_date_time) >= ${startH} and extract(hour from event_date_time) < ${endH}`
      : sql`(extract(hour from event_date_time) >= ${startH} or extract(hour from event_date_time) < ${endH})`;
    const rows = await db.select({
      warehouseId: securityEventsTable.warehouseId,
      total:    sql<number>`count(*)::int`,
      critical: sql<number>`sum(case when ${securityEventsTable.severity} = 'critical' then 1 else 0 end)::int`,
      lastAt:   sql<string | null>`to_char(max(${securityEventsTable.eventDateTime}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
    })
      .from(securityEventsTable)
      .where(and(
        eq(securityEventsTable.companyId, cid),
        gte(securityEventsTable.eventDateTime, since),
        isNotNull(securityEventsTable.warehouseId),
        hourClause,
      ))
      .groupBy(securityEventsTable.warehouseId)
      .orderBy(desc(sql`count(*)`))
      .limit(100);
    res.json({ since, startHour: startH, endHour: endH, items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/branch-comparison", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const since = sinceFromDays(req);
    const events = await db.select({
      branchId: securityEventsTable.branchId,
      total: sql<number>`count(*)::int`,
      critical: sql<number>`sum(case when ${securityEventsTable.severity} = 'critical' then 1 else 0 end)::int`,
      open:     sql<number>`sum(case when ${securityEventsTable.status} = 'open' then 1 else 0 end)::int`,
    })
      .from(securityEventsTable)
      .where(and(eq(securityEventsTable.companyId, cid), gte(securityEventsTable.eventDateTime, since)))
      .groupBy(securityEventsTable.branchId);
    const cams = await db.select({
      branchId: surveillanceDevicesTable.branchId,
      cameras:  sql<number>`count(*)::int`,
    })
      .from(surveillanceDevicesTable)
      .where(eq(surveillanceDevicesTable.companyId, cid))
      .groupBy(surveillanceDevicesTable.branchId);
    const camMap = new Map(cams.map(c => [c.branchId, Number(c.cameras)]));
    const items = events.map(e => ({
      ...e,
      cameras: camMap.get(e.branchId) ?? 0,
    }));
    res.json({ since, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/actions-summary", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const since = sinceFromDays(req);
    const rows = await db.select({
      kind: securityActionsTable.kind,
      targetModule: securityActionsTable.targetModule,
      total: sql<number>`count(*)::int`,
    })
      .from(securityActionsTable)
      .where(and(eq(securityActionsTable.companyId, cid), gte(securityActionsTable.createdAt, since)))
      .groupBy(securityActionsTable.kind, securityActionsTable.targetModule)
      .orderBy(desc(sql`count(*)`));
    res.json({ since, items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
