// ─────────────────────────────────────────────────────────────────────────
// CRM module — Leads, Opportunities, Activities, Campaigns, Pipeline.
// Multi-tenant (companyId scoped). RBAC gate: module key "crm".
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  crmLeadsTable,
  crmOpportunitiesTable,
  crmActivitiesTable,
  crmCampaignsTable,
  crmPipelineStagesTable,
  customersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
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

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
async function ownsRow(table: any, id: number, cid: number): Promise<boolean> {
  if (!Number.isFinite(id) || id <= 0) return false;
  const [r] = await db.select({ id: table.id }).from(table)
    .where(and(eq(table.id, id), eq(table.companyId, cid)));
  return !!r;
}
async function assertOwn(res: any, table: any, id: number, cid: number, label: string): Promise<boolean> {
  const ok = await ownsRow(table, id, cid);
  if (!ok) { res.status(404).json({ error: `${label} غير موجود` }); return false; }
  return true;
}
async function nextCode(cid: number, table: any, prefix: string): Promise<string> {
  const rows = await db.select({ v: table.code }).from(table).where(eq(table.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(r.v).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const LEAD_STATUSES   = ["new","contacted","qualified","rejected","converted"] as const;
const INTEREST_LEVELS = ["cold","warm","hot"] as const;
const OPP_STAGES      = ["prospecting","qualification","proposal","negotiation","closed_won","closed_lost"] as const;
const ACT_TYPES       = ["call","meeting","task","visit","email","note"] as const;
const ACT_RELS        = ["lead","customer","opportunity"] as const;
const CHANNELS        = ["facebook","google","instagram","tiktok","snapchat","email","sms","referral","event","other"] as const;

// ════════════════════════════════════════════════════════════════════════
// LEADS
// ════════════════════════════════════════════════════════════════════════
router.get("/leads", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(crmLeadsTable)
      .where(eq(crmLeadsTable.companyId, cid)).orderBy(desc(crmLeadsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/leads", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "اسم العميل المحتمل مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, crmLeadsTable, "LD");
    const status   = (LEAD_STATUSES   as readonly string[]).includes(b.status)        ? b.status        : "new";
    const interest = (INTEREST_LEVELS as readonly string[]).includes(b.interestLevel) ? b.interestLevel : "warm";
    const [row] = await db.insert(crmLeadsTable).values({
      companyId: cid,
      branchId: b.branchId ? Number(b.branchId) : null,
      code, name,
      mobile: b.mobile || null,
      email:  b.email  || null,
      source: b.source || null,
      campaignId: b.campaignId ? Number(b.campaignId) : null,
      industry: b.industry || null,
      interestLevel: interest as any,
      status: status as any,
      assignedToUserId: b.assignedToUserId ? Number(b.assignedToUserId) : null,
      conversionScore: String(b.conversionScore ?? "0"),
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/leads/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmLeadsTable, id, cid, "العميل المحتمل")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["code","name","mobile","email","source","industry","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    if (b.branchId !== undefined) patch.branchId = b.branchId ? Number(b.branchId) : null;
    if (b.campaignId !== undefined) patch.campaignId = b.campaignId ? Number(b.campaignId) : null;
    if (b.assignedToUserId !== undefined) patch.assignedToUserId = b.assignedToUserId ? Number(b.assignedToUserId) : null;
    if (b.conversionScore !== undefined) patch.conversionScore = String(b.conversionScore || "0");
    if ((LEAD_STATUSES   as readonly string[]).includes(b.status))        patch.status = b.status;
    if ((INTEREST_LEVELS as readonly string[]).includes(b.interestLevel)) patch.interestLevel = b.interestLevel;
    const [row] = await db.update(crmLeadsTable).set(patch)
      .where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/leads/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmLeadsTable, id, cid, "العميل المحتمل")) return;
    await db.delete(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Convert lead → customer
router.post("/leads/:id/convert", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmLeadsTable, id, cid, "العميل المحتمل")) return;
    const [lead] = await db.select().from(crmLeadsTable)
      .where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.companyId, cid)));
    if (!lead) { res.status(404).json({ error: "العميل المحتمل غير موجود" }); return; }
    if (lead.convertedCustomerId) {
      res.status(400).json({ error: "تم تحويل هذا العميل المحتمل سابقاً" }); return;
    }
    const [customer] = await db.insert(customersTable).values({
      companyId: cid,
      nameAr: lead.name,
      email: lead.email || null,
      phone: lead.mobile || null,
    }).returning();
    const [updated] = await db.update(crmLeadsTable).set({
      status: "converted" as any,
      convertedCustomerId: customer.id,
      updatedAt: new Date(),
    }).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.companyId, cid))).returning();
    res.json({ lead: updated, customer });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// CAMPAIGNS
// ════════════════════════════════════════════════════════════════════════
router.get("/campaigns", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(crmCampaignsTable)
      .where(eq(crmCampaignsTable.companyId, cid)).orderBy(desc(crmCampaignsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/campaigns", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "اسم الحملة مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, crmCampaignsTable, "CMP");
    const channel = (CHANNELS as readonly string[]).includes(b.channel) ? b.channel : "other";
    const [row] = await db.insert(crmCampaignsTable).values({
      companyId: cid,
      code, name,
      channel: channel as any,
      budget: String(b.budget ?? "0"),
      startDate: b.startDate || null,
      endDate:   b.endDate   || null,
      expectedRevenue: String(b.expectedRevenue ?? "0"),
      actualRevenue:   String(b.actualRevenue   ?? "0"),
      isActive: b.isActive !== false,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/campaigns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmCampaignsTable, id, cid, "الحملة")) return;
    const b = req.body ?? {};
    const patch: any = {};
    for (const k of ["code","name","notes"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    for (const k of ["budget","expectedRevenue","actualRevenue"]) {
      if (b[k] !== undefined) patch[k] = String(b[k] || "0");
    }
    if (b.startDate !== undefined) patch.startDate = b.startDate || null;
    if (b.endDate   !== undefined) patch.endDate   = b.endDate   || null;
    if (b.isActive !== undefined) patch.isActive = !!b.isActive;
    if ((CHANNELS as readonly string[]).includes(b.channel)) patch.channel = b.channel;
    const [row] = await db.update(crmCampaignsTable).set(patch)
      .where(and(eq(crmCampaignsTable.id, id), eq(crmCampaignsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/campaigns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmCampaignsTable, id, cid, "الحملة")) return;
    await db.delete(crmCampaignsTable).where(and(eq(crmCampaignsTable.id, id), eq(crmCampaignsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PIPELINE STAGES
// ════════════════════════════════════════════════════════════════════════
router.get("/pipeline", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(crmPipelineStagesTable)
      .where(eq(crmPipelineStagesTable.companyId, cid))
      .orderBy(crmPipelineStagesTable.orderNo);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/pipeline", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "اسم المرحلة مطلوب" }); return; }
    const [row] = await db.insert(crmPipelineStagesTable).values({
      companyId: cid, name,
      orderNo: Number(b.orderNo ?? 0),
      probability: String(b.probability ?? "50"),
      isActive: b.isActive !== false,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/pipeline/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmPipelineStagesTable, id, cid, "المرحلة")) return;
    const b = req.body ?? {};
    const patch: any = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.orderNo !== undefined) patch.orderNo = Number(b.orderNo || 0);
    if (b.probability !== undefined) patch.probability = String(b.probability || "0");
    if (b.isActive !== undefined) patch.isActive = !!b.isActive;
    const [row] = await db.update(crmPipelineStagesTable).set(patch)
      .where(and(eq(crmPipelineStagesTable.id, id), eq(crmPipelineStagesTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/pipeline/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmPipelineStagesTable, id, cid, "المرحلة")) return;
    await db.delete(crmPipelineStagesTable).where(and(eq(crmPipelineStagesTable.id, id), eq(crmPipelineStagesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// OPPORTUNITIES
// ════════════════════════════════════════════════════════════════════════
router.get("/opportunities", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(crmOpportunitiesTable)
      .where(eq(crmOpportunitiesTable.companyId, cid)).orderBy(desc(crmOpportunitiesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/opportunities", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const title = String(b.title ?? "").trim();
    if (!title) { res.status(400).json({ error: "عنوان الفرصة مطلوب" }); return; }
    if (b.leadId       && !await ownsRow(crmLeadsTable,         Number(b.leadId),       cid)) { res.status(400).json({ error: "العميل المحتمل غير موجود" }); return; }
    if (b.customerId   && !await ownsRow(customersTable,        Number(b.customerId),   cid)) { res.status(400).json({ error: "العميل غير موجود" });     return; }
    if (b.campaignId   && !await ownsRow(crmCampaignsTable,     Number(b.campaignId),   cid)) { res.status(400).json({ error: "الحملة غير موجودة" });    return; }
    if (b.pipelineStageId && !await ownsRow(crmPipelineStagesTable, Number(b.pipelineStageId), cid)) { res.status(400).json({ error: "المرحلة غير موجودة" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, crmOpportunitiesTable, "OPP");
    const stage = (OPP_STAGES as readonly string[]).includes(b.stage) ? b.stage : "prospecting";
    const [row] = await db.insert(crmOpportunitiesTable).values({
      companyId: cid,
      branchId: b.branchId ? Number(b.branchId) : null,
      code, title,
      leadId:     b.leadId     ? Number(b.leadId)     : null,
      customerId: b.customerId ? Number(b.customerId) : null,
      campaignId: b.campaignId ? Number(b.campaignId) : null,
      pipelineStageId: b.pipelineStageId ? Number(b.pipelineStageId) : null,
      stage: stage as any,
      dealValue:          String(b.dealValue          ?? "0"),
      successProbability: String(b.successProbability ?? "50"),
      expectedCloseDate: b.expectedCloseDate || null,
      assignedToUserId: b.assignedToUserId ? Number(b.assignedToUserId) : null,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/opportunities/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmOpportunitiesTable, id, cid, "الفرصة")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    for (const k of ["code","title","notes","closedReason"]) {
      if (b[k] !== undefined) patch[k] = b[k] || null;
    }
    for (const k of ["dealValue","successProbability"]) {
      if (b[k] !== undefined) patch[k] = String(b[k] || "0");
    }
    if (b.expectedCloseDate !== undefined) patch.expectedCloseDate = b.expectedCloseDate || null;
    if (b.branchId !== undefined) patch.branchId = b.branchId ? Number(b.branchId) : null;
    for (const k of ["leadId","customerId","campaignId","pipelineStageId","assignedToUserId"]) {
      if (b[k] !== undefined) patch[k] = b[k] ? Number(b[k]) : null;
    }
    if ((OPP_STAGES as readonly string[]).includes(b.stage)) {
      patch.stage = b.stage;
      if (b.stage === "closed_won" || b.stage === "closed_lost") patch.closedAt = new Date();
    }
    const [row] = await db.update(crmOpportunitiesTable).set(patch)
      .where(and(eq(crmOpportunitiesTable.id, id), eq(crmOpportunitiesTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/opportunities/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmOpportunitiesTable, id, cid, "الفرصة")) return;
    await db.delete(crmOpportunitiesTable).where(and(eq(crmOpportunitiesTable.id, id), eq(crmOpportunitiesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// ACTIVITIES
// ════════════════════════════════════════════════════════════════════════
router.get("/activities", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(crmActivitiesTable)
      .where(eq(crmActivitiesTable.companyId, cid)).orderBy(desc(crmActivitiesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/activities", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const subject = String(b.subject ?? "").trim();
    if (!subject) { res.status(400).json({ error: "موضوع النشاط مطلوب" }); return; }
    const type = (ACT_TYPES as readonly string[]).includes(b.type) ? b.type : "task";
    const relatedType = (ACT_RELS as readonly string[]).includes(b.relatedType) ? b.relatedType : null;
    if (!relatedType) { res.status(400).json({ error: "نوع الجهة المرتبطة مطلوب" }); return; }
    const relatedId = Number(b.relatedId);
    if (!Number.isFinite(relatedId) || relatedId <= 0) { res.status(400).json({ error: "الجهة المرتبطة مطلوبة" }); return; }
    const refTable = relatedType === "lead" ? crmLeadsTable
                  : relatedType === "customer" ? customersTable
                  : crmOpportunitiesTable;
    if (!await ownsRow(refTable, relatedId, cid)) { res.status(400).json({ error: "الجهة المرتبطة غير موجودة" }); return; }
    const [row] = await db.insert(crmActivitiesTable).values({
      companyId: cid,
      type: type as any,
      relatedType: relatedType as any,
      relatedId,
      subject,
      scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
      completedAt: b.completedAt ? new Date(b.completedAt) : null,
      userId: b.userId ? Number(b.userId) : null,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/activities/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmActivitiesTable, id, cid, "النشاط")) return;
    const b = req.body ?? {};
    const patch: any = {};
    if (b.subject !== undefined) patch.subject = b.subject;
    if (b.notes   !== undefined) patch.notes   = b.notes || null;
    if (b.userId  !== undefined) patch.userId  = b.userId ? Number(b.userId) : null;
    if (b.scheduledAt !== undefined) patch.scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : null;
    if (b.completedAt !== undefined) patch.completedAt = b.completedAt ? new Date(b.completedAt) : null;
    if ((ACT_TYPES as readonly string[]).includes(b.type)) patch.type = b.type;
    const [row] = await db.update(crmActivitiesTable).set(patch)
      .where(and(eq(crmActivitiesTable.id, id), eq(crmActivitiesTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/activities/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, crmActivitiesTable, id, cid, "النشاط")) return;
    await db.delete(crmActivitiesTable).where(and(eq(crmActivitiesTable.id, id), eq(crmActivitiesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// SUMMARY (dashboard counts)
// ════════════════════════════════════════════════════════════════════════
router.get("/summary", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const [leads, opps, activities, campaigns] = await Promise.all([
      db.select().from(crmLeadsTable).where(eq(crmLeadsTable.companyId, cid)),
      db.select().from(crmOpportunitiesTable).where(eq(crmOpportunitiesTable.companyId, cid)),
      db.select().from(crmActivitiesTable).where(eq(crmActivitiesTable.companyId, cid)),
      db.select().from(crmCampaignsTable).where(eq(crmCampaignsTable.companyId, cid)),
    ]);
    const leadsByStatus: Record<string, number> = {};
    for (const l of leads) leadsByStatus[l.status] = (leadsByStatus[l.status] || 0) + 1;
    const oppsByStage: Record<string, number> = {};
    let pipelineValue = 0, weightedValue = 0;
    for (const o of opps) {
      oppsByStage[o.stage] = (oppsByStage[o.stage] || 0) + 1;
      const v = Number(o.dealValue || 0);
      pipelineValue += v;
      weightedValue += v * (Number(o.successProbability || 0) / 100);
    }
    res.json({
      leadsCount: leads.length,
      opportunitiesCount: opps.length,
      activitiesCount: activities.length,
      campaignsCount: campaigns.length,
      leadsByStatus, oppsByStage,
      pipelineValue, weightedValue,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
