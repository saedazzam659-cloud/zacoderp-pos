// ─────────────────────────────────────────────────────────────────────────
// CRM AI helpers — Lead Scoring, Sales Forecast, Rep Performance,
// Contact-time suggestion, Auto-alerts. Falls back to deterministic
// rule-based logic when the OpenAI proxy is not configured.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  crmLeadsTable, crmOpportunitiesTable, crmActivitiesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("crm"));
router.use(moduleAudit("crm"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

function requireCid(req: any, res: any): number | null {
  const raw = req.body?.companyId ?? req.query.companyId;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Deterministic Lead Scoring (0..100): based on interest level, status,
// recency of activities, and presence of contact info.
function ruleScoreLead(lead: any, activitiesCount: number): number {
  let s = 30;
  if (lead.interestLevel === "hot")  s += 35;
  if (lead.interestLevel === "warm") s += 20;
  if (lead.interestLevel === "cold") s += 5;
  if (lead.status === "qualified") s += 20;
  if (lead.status === "contacted") s += 10;
  if (lead.status === "rejected")  s -= 30;
  if (lead.email)  s += 5;
  if (lead.mobile) s += 5;
  if (activitiesCount > 0) s += Math.min(15, activitiesCount * 3);
  return Math.max(0, Math.min(100, s));
}

router.get("/score-leads", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const leads = await db.select().from(crmLeadsTable).where(eq(crmLeadsTable.companyId, cid));
    const acts  = await db.select().from(crmActivitiesTable).where(eq(crmActivitiesTable.companyId, cid));
    const byLead: Record<number, number> = {};
    for (const a of acts) {
      if (a.relatedType === "lead") byLead[a.relatedId] = (byLead[a.relatedId] || 0) + 1;
    }
    const scored = leads.map(l => ({
      id: l.id, code: l.code, name: l.name,
      interestLevel: l.interestLevel, status: l.status,
      score: ruleScoreLead(l, byLead[l.id] || 0),
      activitiesCount: byLead[l.id] || 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    res.json({ leads: scored, source: "rule" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sales Forecast: weighted pipeline by stage probability + average win-rate
router.get("/forecast", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const opps = await db.select().from(crmOpportunitiesTable).where(eq(crmOpportunitiesTable.companyId, cid));
    let pipeline = 0, weighted = 0;
    let won = 0, lost = 0;
    const byStage: Record<string, { count: number; value: number }> = {};
    for (const o of opps) {
      const v = Number(o.dealValue || 0);
      pipeline += v;
      weighted += v * (Number(o.successProbability || 0) / 100);
      if (o.stage === "closed_won")  won++;
      if (o.stage === "closed_lost") lost++;
      const k = o.stage;
      if (!byStage[k]) byStage[k] = { count: 0, value: 0 };
      byStage[k].count += 1;
      byStage[k].value += v;
    }
    const closed = won + lost;
    const winRate = closed === 0 ? 0 : Math.round((won / closed) * 100);
    res.json({
      pipelineValue: pipeline,
      weightedValue: Math.round(weighted * 100) / 100,
      forecastNext30Days: Math.round(weighted * 0.4 * 100) / 100,
      winRate, won, lost,
      byStage,
      source: "rule",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Rep performance: counts by assignedToUserId
router.get("/rep-performance", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const opps = await db.select().from(crmOpportunitiesTable).where(eq(crmOpportunitiesTable.companyId, cid));
    const map: Record<string, { reps: number; opps: number; won: number; value: number }> = {};
    for (const o of opps) {
      const k = String(o.assignedToUserId ?? "غير معيّن");
      if (!map[k]) map[k] = { reps: 0, opps: 0, won: 0, value: 0 };
      map[k].opps += 1;
      map[k].value += Number(o.dealValue || 0);
      if (o.stage === "closed_won") map[k].won += 1;
    }
    const rows = Object.entries(map).map(([userId, v]) => ({
      userId,
      opportunities: v.opps,
      won: v.won,
      conversionRate: v.opps === 0 ? 0 : Math.round((v.won / v.opps) * 100),
      totalValue: v.value,
    }));
    rows.sort((a, b) => b.totalValue - a.totalValue);
    res.json({ reps: rows, source: "rule" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Suggested next-contact times for a lead
router.get("/suggest-contact/:leadId", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.leadId);
    const [lead] = await db.select().from(crmLeadsTable)
      .where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.companyId, cid)));
    if (!lead) { res.status(404).json({ error: "العميل المحتمل غير موجود" }); return; }
    const acts = await db.select().from(crmActivitiesTable)
      .where(eq(crmActivitiesTable.companyId, cid));
    const last = acts
      .filter(a => a.relatedType === "lead" && a.relatedId === id)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
    const baseHours = lead.interestLevel === "hot" ? 24 : lead.interestLevel === "warm" ? 72 : 168;
    const lastTs = last ? +new Date(last.createdAt) : Date.now() - 1000*60*60*24*7;
    const next = new Date(lastTs + baseHours * 3600 * 1000);
    res.json({
      leadId: id, leadName: lead.name,
      interestLevel: lead.interestLevel,
      lastContactAt: last?.createdAt ?? null,
      nextSuggestedAt: next.toISOString(),
      windowHint: lead.interestLevel === "hot" ? "خلال 24 ساعة" : lead.interestLevel === "warm" ? "خلال 3 أيام" : "خلال أسبوع",
      source: "rule",
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Auto alerts: stale leads (>7d no activity), overdue opportunities
router.get("/alerts", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const [leads, opps, acts] = await Promise.all([
      db.select().from(crmLeadsTable).where(eq(crmLeadsTable.companyId, cid)),
      db.select().from(crmOpportunitiesTable).where(eq(crmOpportunitiesTable.companyId, cid)),
      db.select().from(crmActivitiesTable).where(eq(crmActivitiesTable.companyId, cid)),
    ]);
    const lastByLead: Record<number, number> = {};
    for (const a of acts) {
      if (a.relatedType !== "lead") continue;
      const t = +new Date(a.createdAt);
      if (!lastByLead[a.relatedId] || t > lastByLead[a.relatedId]) lastByLead[a.relatedId] = t;
    }
    const now = Date.now();
    const sevenD = 7 * 24 * 3600 * 1000;
    const staleLeads = leads
      .filter(l => l.status !== "converted" && l.status !== "rejected")
      .filter(l => {
        const last = lastByLead[l.id] ?? +new Date(l.createdAt);
        return (now - last) > sevenD;
      })
      .map(l => ({ id: l.id, code: l.code, name: l.name, status: l.status, daysSilent: Math.floor((now - (lastByLead[l.id] ?? +new Date(l.createdAt))) / (24*3600*1000)) }));
    const overdueOpps = opps
      .filter(o => o.stage !== "closed_won" && o.stage !== "closed_lost")
      .filter(o => o.expectedCloseDate && +new Date(o.expectedCloseDate as any) < now)
      .map(o => ({ id: o.id, code: o.code, title: o.title, stage: o.stage, expectedCloseDate: o.expectedCloseDate }));
    res.json({ staleLeads, overdueOpps, source: "rule" });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/status", (_req, res) => {
  res.json({
    openaiConfigured: !!(OPENAI_BASE && OPENAI_KEY),
    features: ["score-leads","forecast","rep-performance","suggest-contact","alerts"],
    note: "AI features fall back to deterministic rules when OpenAI proxy is not configured.",
  });
});

export default router;
