// ─────────────────────────────────────────────────────────────────────────
// Maintenance ERP — assets, technicians, work orders, spare parts.
// Multi-tenant (companyId scoped). RBAC gate: module key "maintenance".
// All endpoints require authenticated user; SuperAdmin bypasses gate.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  maintenanceAssetsTable,
  maintenanceTechniciansTable,
  maintenanceOrdersTable,
  maintenanceOrderPartsTable,
  itemsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("maintenance"));
router.use(moduleAudit("maintenance"));
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

// ─── Code generators ────────────────────────────────────────────────────
async function nextCode(
  cid: number,
  table: typeof maintenanceAssetsTable | typeof maintenanceTechniciansTable | typeof maintenanceOrdersTable,
  prefix: string,
  field: "code" | "docNumber",
): Promise<string> {
  const rows = field === "docNumber"
    ? await db.select({ code: maintenanceOrdersTable.docNumber }).from(maintenanceOrdersTable).where(eq(maintenanceOrdersTable.companyId, cid))
    : await db.select({ code: (table as any).code }).from(table as any).where(eq((table as any).companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(r.code).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const ASSET_CATEGORIES = ["vehicle","machine","equipment","tool","building","it_hardware","other"] as const;
const ASSET_STATUSES   = ["active","in_repair","out_of_service","retired"] as const;
const ORDER_TYPES      = ["preventive","corrective","emergency","inspection"] as const;
const ORDER_PRIORITIES = ["low","medium","high","urgent"] as const;
const ORDER_STATUSES   = ["draft","scheduled","in_progress","completed","cancelled"] as const;

// ════════════════════════════════════════════════════════════════════════
// ASSETS
// ════════════════════════════════════════════════════════════════════════
router.get("/assets", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(maintenanceAssetsTable)
      .where(eq(maintenanceAssetsTable.companyId, cid))
      .orderBy(desc(maintenanceAssetsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/assets/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(maintenanceAssetsTable)
      .where(and(eq(maintenanceAssetsTable.id, id), eq(maintenanceAssetsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "الأصل غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/assets", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم الأصل مطلوب" }); return; }
    const code = String(b.code ?? "").trim()
      || await nextCode(cid, maintenanceAssetsTable, "AST", "code");

    const [row] = await db.insert(maintenanceAssetsTable).values({
      companyId:      cid,
      branchId:       b.branchId ? Number(b.branchId) : null,
      code,
      nameAr,
      nameEn:         b.nameEn || null,
      category:       ASSET_CATEGORIES.includes(b.category) ? b.category : "equipment",
      serialNumber:   b.serialNumber || null,
      location:       b.location || null,
      manufacturer:   b.manufacturer || null,
      model:          b.model || null,
      purchaseDate:   b.purchaseDate || null,
      purchasePrice:  b.purchasePrice != null && b.purchasePrice !== "" ? String(b.purchasePrice) : null,
      warrantyExpiry: b.warrantyExpiry || null,
      status:         ASSET_STATUSES.includes(b.status) ? b.status : "active",
      notes:          b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "كود الأصل مستخدم مسبقاً" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/assets/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [row] = await db.update(maintenanceAssetsTable).set({
      branchId:       b.branchId ? Number(b.branchId) : null,
      code:           b.code != null ? String(b.code).trim() : undefined,
      nameAr:         b.nameAr != null ? String(b.nameAr).trim() : undefined,
      nameEn:         b.nameEn ?? null,
      category:       ASSET_CATEGORIES.includes(b.category) ? b.category : undefined,
      serialNumber:   b.serialNumber ?? null,
      location:       b.location ?? null,
      manufacturer:   b.manufacturer ?? null,
      model:          b.model ?? null,
      purchaseDate:   b.purchaseDate ?? null,
      purchasePrice:  b.purchasePrice != null && b.purchasePrice !== "" ? String(b.purchasePrice) : null,
      warrantyExpiry: b.warrantyExpiry ?? null,
      status:         ASSET_STATUSES.includes(b.status) ? b.status : undefined,
      notes:          b.notes ?? null,
      updatedAt:      new Date(),
    }).where(and(eq(maintenanceAssetsTable.id, id), eq(maintenanceAssetsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الأصل غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/assets/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(maintenanceOrdersTable)
      .where(and(eq(maintenanceOrdersTable.companyId, cid), eq(maintenanceOrdersTable.assetId, id)));
    if (n > 0) {
      res.status(409).json({ error: `لا يمكن حذف الأصل — مرتبط بـ ${n} أمر صيانة. يمكنك تغيير حالته إلى "خارج الخدمة" بدلاً من ذلك.` });
      return;
    }
    await db.delete(maintenanceAssetsTable)
      .where(and(eq(maintenanceAssetsTable.id, id), eq(maintenanceAssetsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// TECHNICIANS
// ════════════════════════════════════════════════════════════════════════
router.get("/technicians", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(maintenanceTechniciansTable)
      .where(eq(maintenanceTechniciansTable.companyId, cid))
      .orderBy(desc(maintenanceTechniciansTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/technicians", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم الفني مطلوب" }); return; }
    const code = String(b.code ?? "").trim()
      || await nextCode(cid, maintenanceTechniciansTable, "TECH", "code");

    const [row] = await db.insert(maintenanceTechniciansTable).values({
      companyId:      cid,
      branchId:       b.branchId ? Number(b.branchId) : null,
      code,
      nameAr,
      nameEn:         b.nameEn || null,
      phone:          b.phone || null,
      email:          b.email || null,
      specialization: b.specialization || null,
      hourlyRate:     b.hourlyRate != null ? String(b.hourlyRate) : "0",
      isActive:       b.isActive !== false,
      notes:          b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "كود الفني مستخدم مسبقاً" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/technicians/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [row] = await db.update(maintenanceTechniciansTable).set({
      branchId:       b.branchId ? Number(b.branchId) : null,
      code:           b.code != null ? String(b.code).trim() : undefined,
      nameAr:         b.nameAr != null ? String(b.nameAr).trim() : undefined,
      nameEn:         b.nameEn ?? null,
      phone:          b.phone ?? null,
      email:          b.email ?? null,
      specialization: b.specialization ?? null,
      hourlyRate:     b.hourlyRate != null ? String(b.hourlyRate) : undefined,
      isActive:       b.isActive !== undefined ? !!b.isActive : undefined,
      notes:          b.notes ?? null,
      updatedAt:      new Date(),
    }).where(and(eq(maintenanceTechniciansTable.id, id), eq(maintenanceTechniciansTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "الفني غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/technicians/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(maintenanceOrdersTable)
      .where(and(eq(maintenanceOrdersTable.companyId, cid), eq(maintenanceOrdersTable.technicianId, id)));
    if (n > 0) {
      res.status(409).json({ error: `لا يمكن حذف الفني — مرتبط بـ ${n} أمر صيانة. يمكنك تعطيله بدلاً من ذلك.` });
      return;
    }
    await db.delete(maintenanceTechniciansTable)
      .where(and(eq(maintenanceTechniciansTable.id, id), eq(maintenanceTechniciansTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// WORK ORDERS
// ════════════════════════════════════════════════════════════════════════
router.get("/orders", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select({
      o: maintenanceOrdersTable,
      assetCode: maintenanceAssetsTable.code,
      assetName: maintenanceAssetsTable.nameAr,
      techName:  maintenanceTechniciansTable.nameAr,
    })
      .from(maintenanceOrdersTable)
      .leftJoin(maintenanceAssetsTable,       eq(maintenanceAssetsTable.id,       maintenanceOrdersTable.assetId))
      .leftJoin(maintenanceTechniciansTable,  eq(maintenanceTechniciansTable.id,  maintenanceOrdersTable.technicianId))
      .where(eq(maintenanceOrdersTable.companyId, cid))
      .orderBy(desc(maintenanceOrdersTable.id));
    res.json(rows.map(r => ({ ...r.o, assetCode: r.assetCode, assetName: r.assetName, techName: r.techName })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(maintenanceOrdersTable)
      .where(and(eq(maintenanceOrdersTable.id, id), eq(maintenanceOrdersTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "أمر الصيانة غير موجود" }); return; }

    const parts = await db.select({
      p: maintenanceOrderPartsTable,
      itemCode: itemsTable.sku,
      itemName: itemsTable.nameAr,
    })
      .from(maintenanceOrderPartsTable)
      .leftJoin(itemsTable, eq(itemsTable.id, maintenanceOrderPartsTable.itemId))
      .where(eq(maintenanceOrderPartsTable.orderId, id));
    res.json({
      ...row,
      parts: parts.map(p => ({ ...p.p, itemCode: p.itemCode, itemName: p.itemName })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function recomputeTotals(b: any) {
  const labor = Number(b.laborCost ?? 0);
  const parts = Number(b.partsCost ?? 0);
  return { laborCost: String(labor), partsCost: String(parts), totalCost: String(labor + parts) };
}

router.post("/orders", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.assetId)            { res.status(400).json({ error: "الأصل مطلوب" }); return; }
    if (!b.problemDescription) { res.status(400).json({ error: "وصف المشكلة مطلوب" }); return; }
    if (!b.reportedDate)       { res.status(400).json({ error: "تاريخ البلاغ مطلوب" }); return; }

    const docNumber = String(b.docNumber ?? "").trim()
      || await nextCode(cid, maintenanceOrdersTable, "MO", "docNumber");

    const totals = recomputeTotals(b);
    const [row] = await db.insert(maintenanceOrdersTable).values({
      companyId:          cid,
      branchId:           b.branchId ? Number(b.branchId) : null,
      docNumber,
      assetId:            Number(b.assetId),
      technicianId:       b.technicianId ? Number(b.technicianId) : null,
      orderType:          ORDER_TYPES.includes(b.orderType) ? b.orderType : "corrective",
      priority:           ORDER_PRIORITIES.includes(b.priority) ? b.priority : "medium",
      status:             ORDER_STATUSES.includes(b.status) ? b.status : "draft",
      reportedDate:       String(b.reportedDate),
      scheduledDate:      b.scheduledDate || null,
      startDate:          b.startDate || null,
      completionDate:     b.completionDate || null,
      problemDescription: String(b.problemDescription),
      diagnosis:          b.diagnosis || null,
      workPerformed:      b.workPerformed || null,
      laborHours:         b.laborHours != null ? String(b.laborHours) : "0",
      laborCost:          totals.laborCost,
      partsCost:          totals.partsCost,
      totalCost:          totals.totalCost,
      reportedBy:         b.reportedBy || null,
      notes:              b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505")
      return res.status(409).json({ error: "رقم أمر الصيانة مستخدم مسبقاً" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const totals = recomputeTotals(b);
    const [row] = await db.update(maintenanceOrdersTable).set({
      branchId:           b.branchId ? Number(b.branchId) : null,
      docNumber:          b.docNumber != null ? String(b.docNumber).trim() : undefined,
      assetId:            b.assetId ? Number(b.assetId) : undefined,
      technicianId:       b.technicianId ? Number(b.technicianId) : null,
      orderType:          ORDER_TYPES.includes(b.orderType) ? b.orderType : undefined,
      priority:           ORDER_PRIORITIES.includes(b.priority) ? b.priority : undefined,
      status:             ORDER_STATUSES.includes(b.status) ? b.status : undefined,
      reportedDate:       b.reportedDate ? String(b.reportedDate) : undefined,
      scheduledDate:      b.scheduledDate ?? null,
      startDate:          b.startDate ?? null,
      completionDate:     b.completionDate ?? null,
      problemDescription: b.problemDescription != null ? String(b.problemDescription) : undefined,
      diagnosis:          b.diagnosis ?? null,
      workPerformed:      b.workPerformed ?? null,
      laborHours:         b.laborHours != null ? String(b.laborHours) : undefined,
      laborCost:          totals.laborCost,
      partsCost:          totals.partsCost,
      totalCost:          totals.totalCost,
      reportedBy:         b.reportedBy ?? null,
      notes:              b.notes ?? null,
      updatedAt:          new Date(),
    }).where(and(eq(maintenanceOrdersTable.id, id), eq(maintenanceOrdersTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "أمر الصيانة غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(maintenanceOrdersTable)
      .where(and(eq(maintenanceOrdersTable.id, id), eq(maintenanceOrdersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Order parts (sub-resource) ─────────────────────────────────────────
router.post("/orders/:id/parts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const orderId = Number(req.params.id);
    const b = req.body ?? {};
    if (!b.itemId) { res.status(400).json({ error: "الصنف مطلوب" }); return; }

    // Verify the order belongs to this company.
    const [own] = await db.select({ id: maintenanceOrdersTable.id })
      .from(maintenanceOrdersTable)
      .where(and(eq(maintenanceOrdersTable.id, orderId), eq(maintenanceOrdersTable.companyId, cid)));
    if (!own) { res.status(404).json({ error: "أمر الصيانة غير موجود" }); return; }

    const qty  = Number(b.quantity ?? 1);
    const cost = Number(b.unitCost ?? 0);
    const [row] = await db.insert(maintenanceOrderPartsTable).values({
      orderId,
      itemId:   Number(b.itemId),
      quantity: String(qty),
      unitCost: String(cost),
      total:    String(qty * cost),
      notes:    b.notes || null,
    }).returning();
    await refreshPartsCost(cid, orderId);
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/orders/:id/parts/:pid", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const orderId = Number(req.params.id);
    const pid = Number(req.params.pid);
    const [own] = await db.select({ id: maintenanceOrdersTable.id })
      .from(maintenanceOrdersTable)
      .where(and(eq(maintenanceOrdersTable.id, orderId), eq(maintenanceOrdersTable.companyId, cid)));
    if (!own) { res.status(404).json({ error: "أمر الصيانة غير موجود" }); return; }
    await db.delete(maintenanceOrderPartsTable)
      .where(and(eq(maintenanceOrderPartsTable.id, pid), eq(maintenanceOrderPartsTable.orderId, orderId)));
    await refreshPartsCost(cid, orderId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

async function refreshPartsCost(cid: number, orderId: number) {
  const [{ s }] = await db.select({ s: sql<string>`COALESCE(SUM(${maintenanceOrderPartsTable.total}), 0)` })
    .from(maintenanceOrderPartsTable)
    .where(eq(maintenanceOrderPartsTable.orderId, orderId));
  const [order] = await db.select({ laborCost: maintenanceOrdersTable.laborCost })
    .from(maintenanceOrdersTable)
    .where(and(eq(maintenanceOrdersTable.id, orderId), eq(maintenanceOrdersTable.companyId, cid)));
  if (!order) return;
  const labor = Number(order.laborCost ?? 0);
  const parts = Number(s ?? 0);
  await db.update(maintenanceOrdersTable).set({
    partsCost: String(parts),
    totalCost: String(labor + parts),
    updatedAt: new Date(),
  }).where(and(eq(maintenanceOrdersTable.id, orderId), eq(maintenanceOrdersTable.companyId, cid)));
}

// ─── Summary stats for hub ─────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const [assets] = await db.select({ n: sql<number>`count(*)::int` })
      .from(maintenanceAssetsTable).where(eq(maintenanceAssetsTable.companyId, cid));
    const [techs] = await db.select({ n: sql<number>`count(*)::int` })
      .from(maintenanceTechniciansTable).where(eq(maintenanceTechniciansTable.companyId, cid));
    const [orders] = await db.select({ n: sql<number>`count(*)::int` })
      .from(maintenanceOrdersTable).where(eq(maintenanceOrdersTable.companyId, cid));
    const [open] = await db.select({ n: sql<number>`count(*)::int` })
      .from(maintenanceOrdersTable)
      .where(and(
        eq(maintenanceOrdersTable.companyId, cid),
        sql`${maintenanceOrdersTable.status} IN ('draft','scheduled','in_progress')`,
      ));
    res.json({
      assets:    assets?.n ?? 0,
      technicians: techs?.n ?? 0,
      orders:    orders?.n ?? 0,
      openOrders: open?.n ?? 0,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
