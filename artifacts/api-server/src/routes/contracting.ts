// =====================================================================
// Contracting / Construction ERP — CRUD routes
//
// Permission key: `contracting`. Multi-tenant by companyId.
// Numeric fields are returned as strings (Drizzle numeric → string) which
// the frontend formats with toLocaleString. Dates as YYYY-MM-DD.
// =====================================================================
import { Router } from "express";
import { db } from "@workspace/db";
import {
  contractingProjectsTable,
  contractingContractorsTable,
  contractingWorkItemsTable,
  contractingResourcesTable,
  contractingProgressBillsTable,
  contractingEventsTable,
  contractingRisksTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(requirePermission("contracting"));

// Helper: scope every query to the caller's company.
async function scope(req: any, res: any): Promise<number | null> {
  const cid = await resolveCompanyId(req);
  if (!cid) { res.status(400).json({ error: "لا يوجد شركة" }); return null; }
  return cid;
}

// Helper: write a system event so the project timeline + dashboard alerts
// stay populated automatically. Failures are non-fatal (we still return
// the underlying success response).
async function logEvent(opts: {
  companyId: number;
  projectId?: number | null;
  userId?: number | null;
  eventType: string;
  title: string;
  description?: string | null;
  severity?: "info" | "warn" | "error";
  meta?: Record<string, unknown>;
}) {
  try {
    await db.insert(contractingEventsTable).values({
      companyId: opts.companyId,
      projectId: opts.projectId ?? null,
      userId:    opts.userId ?? null,
      eventType: opts.eventType,
      title:     opts.title,
      description: opts.description ?? null,
      severity:  opts.severity ?? "info",
      meta:      opts.meta ?? {},
    });
  } catch (e) {
    console.warn("[contracting] event log failed", e);
  }
}

// ─────────────────── PROJECTS ───────────────────
router.get("/projects", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const status = (req.query.status as string) || "";
    const search = ((req.query.search as string) || "").trim().toLowerCase();
    let rows = await db.select().from(contractingProjectsTable)
      .where(eq(contractingProjectsTable.companyId, cid))
      .orderBy(desc(contractingProjectsTable.createdAt));
    if (status) rows = rows.filter(r => r.status === status);
    if (search) rows = rows.filter(r =>
      r.nameAr.toLowerCase().includes(search) ||
      (r.nameEn ?? "").toLowerCase().includes(search) ||
      r.code.toLowerCase().includes(search) ||
      (r.location ?? "").toLowerCase().includes(search));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

router.get("/projects/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(contractingProjectsTable)
      .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

router.post("/projects", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body as any;
    if (!b?.nameAr || !b?.code) { res.status(400).json({ error: "الاسم والكود مطلوبان" }); return; }
    const [row] = await db.insert(contractingProjectsTable).values({
      companyId: cid,
      branchId: b.branchId ?? null,
      code: String(b.code),
      nameAr: String(b.nameAr),
      nameEn: b.nameEn ?? null,
      customerId: b.customerId ?? null,
      clientName: b.clientName ?? null,
      location:   b.location   ?? null,
      projectType: b.projectType ?? "building",
      status: b.status ?? "draft",
      contractValue: String(b.contractValue ?? "0"),
      plannedBudget: String(b.plannedBudget ?? "0"),
      actualCost:    String(b.actualCost    ?? "0"),
      plannedStartDate: b.plannedStartDate ?? null,
      plannedEndDate:   b.plannedEndDate ?? null,
      progressPercent: String(b.progressPercent ?? "0"),
      description: b.description ?? null,
    }).returning();
    await logEvent({
      companyId: cid, projectId: row.id, userId: req.authUser!.id,
      eventType: "project_created", title: `إنشاء مشروع: ${row.nameAr}`,
    });
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

router.put("/projects/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const updates: any = { updatedAt: new Date() };
    const passthroughText = ["nameAr","nameEn","clientName","location","description","status","projectType","code"];
    for (const k of passthroughText) if (b[k] !== undefined) updates[k] = b[k];
    const passthroughNum = ["contractValue","plannedBudget","actualCost","progressPercent"];
    for (const k of passthroughNum) if (b[k] !== undefined) updates[k] = String(b[k]);
    if (b.branchId   !== undefined) updates.branchId   = b.branchId;
    if (b.customerId !== undefined) updates.customerId = b.customerId;
    if (b.plannedStartDate !== undefined) updates.plannedStartDate = b.plannedStartDate;
    if (b.plannedEndDate   !== undefined) updates.plannedEndDate   = b.plannedEndDate;

    const [prev] = await db.select().from(contractingProjectsTable)
      .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, cid)));
    if (!prev) { res.status(404).json({ error: "غير موجود" }); return; }

    // Auto-stamp actualStartAt / actualEndAt when status crosses thresholds.
    if (b.status === "in_progress" && !prev.actualStartAt) updates.actualStartAt = new Date();
    if (b.status === "completed"   && !prev.actualEndAt)   updates.actualEndAt   = new Date();

    const [row] = await db.update(contractingProjectsTable)
      .set(updates)
      .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, cid)))
      .returning();
    if (b.status && b.status !== prev.status) {
      await logEvent({
        companyId: cid, projectId: id, userId: req.authUser!.id,
        eventType: "phase_started",
        title: `تغيير حالة المشروع إلى: ${b.status}`,
        description: `من ${prev.status} إلى ${b.status}`,
        severity: b.status === "on_hold" ? "warn" : "info",
      });
    }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

router.delete("/projects/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(contractingProjectsTable)
      .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

// ─────────────────── WORK ITEMS ───────────────────
router.get("/projects/:projectId/work-items", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const rows = await db.select().from(contractingWorkItemsTable)
      .where(and(
        eq(contractingWorkItemsTable.companyId, cid),
        eq(contractingWorkItemsTable.projectId, projectId),
      ))
      .orderBy(contractingWorkItemsTable.id);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/projects/:projectId/work-items", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    if (!b?.nameAr) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    const plannedQty = Number(b.plannedQty ?? 0);
    const unitCost   = Number(b.unitCost   ?? 0);
    const [row] = await db.insert(contractingWorkItemsTable).values({
      companyId: cid,
      projectId,
      code: b.code ?? null,
      nameAr: String(b.nameAr),
      category: b.category ?? "other",
      unit: b.unit ?? "m3",
      plannedQty: String(plannedQty),
      actualQty:  String(b.actualQty ?? 0),
      unitCost:   String(unitCost),
      totalPlannedCost: String(plannedQty * unitCost),
      totalActualCost:  String((Number(b.actualQty ?? 0)) * unitCost),
      progressPercent: String(b.progressPercent ?? 0),
      plannedStartDate: b.plannedStartDate ?? null,
      plannedEndDate:   b.plannedEndDate   ?? null,
      status: b.status ?? "pending",
      contractorId: b.contractorId ?? null,
      notes: b.notes ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/work-items/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const upd: any = { updatedAt: new Date() };
    for (const k of ["code","nameAr","category","unit","status","notes"]) if (b[k] !== undefined) upd[k] = b[k];
    for (const k of ["plannedQty","actualQty","unitCost","progressPercent"]) if (b[k] !== undefined) upd[k] = String(b[k]);
    if (b.contractorId !== undefined) upd.contractorId = b.contractorId;
    if (b.plannedStartDate !== undefined) upd.plannedStartDate = b.plannedStartDate;
    if (b.plannedEndDate   !== undefined) upd.plannedEndDate   = b.plannedEndDate;

    // Recompute totals if any input changed.
    if (b.plannedQty !== undefined || b.unitCost !== undefined || b.actualQty !== undefined) {
      const [cur] = await db.select().from(contractingWorkItemsTable)
        .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)));
      if (cur) {
        const pq = Number(b.plannedQty ?? cur.plannedQty);
        const aq = Number(b.actualQty  ?? cur.actualQty);
        const uc = Number(b.unitCost   ?? cur.unitCost);
        upd.totalPlannedCost = String(pq * uc);
        upd.totalActualCost  = String(aq * uc);
      }
    }

    const [row] = await db.update(contractingWorkItemsTable).set(upd)
      .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }

    // After updating a work item, recompute parent project progress as
    // weighted average (by planned cost) so the project headline metric
    // tracks reality without manual sync.
    const items = await db.select().from(contractingWorkItemsTable)
      .where(eq(contractingWorkItemsTable.projectId, row.projectId));
    const totalWeight = items.reduce((s, i) => s + Number(i.totalPlannedCost), 0);
    const weighted = totalWeight > 0
      ? items.reduce((s, i) => s + Number(i.progressPercent) * Number(i.totalPlannedCost), 0) / totalWeight
      : items.reduce((s, i) => s + Number(i.progressPercent), 0) / Math.max(1, items.length);
    const actualSum = items.reduce((s, i) => s + Number(i.totalActualCost), 0);
    await db.update(contractingProjectsTable).set({
      progressPercent: String(Math.round(weighted * 100) / 100),
      actualCost:      String(Math.round(actualSum * 100) / 100),
      updatedAt: new Date(),
    }).where(eq(contractingProjectsTable.id, row.projectId));

    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/work-items/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(contractingWorkItemsTable)
      .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── RESOURCES ───────────────────
router.get("/resources", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    let rows = await db.select().from(contractingResourcesTable)
      .where(eq(contractingResourcesTable.companyId, cid))
      .orderBy(desc(contractingResourcesTable.createdAt));
    if (projectId !== null) rows = rows.filter(r => r.projectId === projectId);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/resources", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body as any;
    if (!b?.name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    const qty = Number(b.qty ?? 0);
    const uc  = Number(b.unitCost ?? 0);
    const [row] = await db.insert(contractingResourcesTable).values({
      companyId: cid,
      projectId: b.projectId ?? null,
      name: String(b.name),
      type: b.type ?? "material",
      unit: b.unit ?? "hr",
      qty: String(qty),
      unitCost:  String(uc),
      totalCost: String(qty * uc),
      supplierId: b.supplierId ?? null,
      status: b.status ?? "planned",
      notes: b.notes ?? null,
    }).returning();
    if (b.projectId) {
      await logEvent({
        companyId: cid, projectId: b.projectId, userId: req.authUser!.id,
        eventType: "material_issued",
        title: `إضافة مورد: ${row.name}`,
        description: `النوع: ${row.type} — الكمية: ${row.qty} ${row.unit}`,
      });
    }
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/resources/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const upd: any = { updatedAt: new Date() };
    for (const k of ["name","type","unit","status","notes"]) if (b[k] !== undefined) upd[k] = b[k];
    for (const k of ["qty","unitCost"]) if (b[k] !== undefined) upd[k] = String(b[k]);
    if (b.projectId !== undefined) upd.projectId = b.projectId;
    if (b.supplierId !== undefined) upd.supplierId = b.supplierId;
    if (b.qty !== undefined || b.unitCost !== undefined) {
      const [cur] = await db.select().from(contractingResourcesTable)
        .where(and(eq(contractingResourcesTable.id, id), eq(contractingResourcesTable.companyId, cid)));
      if (cur) {
        upd.totalCost = String(Number(b.qty ?? cur.qty) * Number(b.unitCost ?? cur.unitCost));
      }
    }
    if (b.status === "consumed" || b.status === "in_use") upd.usedAt = new Date();
    const [row] = await db.update(contractingResourcesTable).set(upd)
      .where(and(eq(contractingResourcesTable.id, id), eq(contractingResourcesTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/resources/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(contractingResourcesTable)
      .where(and(eq(contractingResourcesTable.id, id), eq(contractingResourcesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── CONTRACTORS ───────────────────
router.get("/contractors", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const rows = await db.select().from(contractingContractorsTable)
      .where(eq(contractingContractorsTable.companyId, cid))
      .orderBy(contractingContractorsTable.name);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/contractors", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body as any;
    if (!b?.name) { res.status(400).json({ error: "الاسم مطلوب" }); return; }
    const [row] = await db.insert(contractingContractorsTable).values({
      companyId: cid,
      supplierId: b.supplierId ?? null,
      name: String(b.name),
      contactPerson: b.contactPerson ?? null,
      phone: b.phone ?? null,
      email: b.email ?? null,
      address: b.address ?? null,
      specialty: b.specialty ?? "general",
      rating: String(b.rating ?? 0),
      status: b.status ?? "active",
      notes: b.notes ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/contractors/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const upd: any = { updatedAt: new Date() };
    for (const k of ["name","contactPerson","phone","email","address","specialty","status","notes"]) {
      if (b[k] !== undefined) upd[k] = b[k];
    }
    if (b.rating !== undefined) upd.rating = String(b.rating);
    if (b.supplierId !== undefined) upd.supplierId = b.supplierId;
    const [row] = await db.update(contractingContractorsTable).set(upd)
      .where(and(eq(contractingContractorsTable.id, id), eq(contractingContractorsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/contractors/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(contractingContractorsTable)
      .where(and(eq(contractingContractorsTable.id, id), eq(contractingContractorsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── PROGRESS BILLS (مستخلصات) ───────────────────
router.get("/projects/:projectId/bills", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const rows = await db.select().from(contractingProgressBillsTable)
      .where(and(
        eq(contractingProgressBillsTable.companyId, cid),
        eq(contractingProgressBillsTable.projectId, projectId),
      ))
      .orderBy(desc(contractingProgressBillsTable.billDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/projects/:projectId/bills", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    if (!b?.billNumber || !b?.billDate) {
      res.status(400).json({ error: "رقم وتاريخ المستخلص مطلوبان" }); return;
    }

    // Server-side computation. Client may send raw values; we recompute the
    // derived ones here so the math is consistent and tamper-resistant.
    const gross     = Number(b.grossAmount ?? 0);
    const retPct    = Number(b.retentionPercent ?? 0);
    const prevPaid  = Number(b.previousPaid ?? 0);
    const retAmount = Math.round((gross * retPct / 100) * 100) / 100;
    const dueAmount = Math.max(0, Math.round((gross - retAmount - prevPaid) * 100) / 100);
    const vatAmount = Math.round((dueAmount * 0.15) * 100) / 100; // SA standard 15%
    const netAmount = Math.round((dueAmount + vatAmount) * 100) / 100;

    const [row] = await db.insert(contractingProgressBillsTable).values({
      companyId: cid, projectId,
      billNumber: String(b.billNumber),
      billType: b.billType ?? "interim",
      billDate: b.billDate,
      fromDate: b.fromDate ?? null,
      toDate:   b.toDate   ?? null,
      progressPercent: String(b.progressPercent ?? 0),
      grossAmount:      String(gross),
      retentionPercent: String(retPct),
      retentionAmount:  String(retAmount),
      previousPaid:     String(prevPaid),
      dueAmount:        String(dueAmount),
      vatAmount:        String(vatAmount),
      netAmount:        String(netAmount),
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    }).returning();
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "bill_submitted",
      title: `مستخلص جديد رقم ${row.billNumber}`,
      description: `صافي مستحق: ${row.netAmount} ر.س`,
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/bills/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const [cur] = await db.select().from(contractingProgressBillsTable)
      .where(and(eq(contractingProgressBillsTable.id, id), eq(contractingProgressBillsTable.companyId, cid)));
    if (!cur) { res.status(404).json({ error: "غير موجود" }); return; }

    const upd: any = { updatedAt: new Date() };
    for (const k of ["billNumber","billType","status","notes"]) if (b[k] !== undefined) upd[k] = b[k];
    if (b.billDate !== undefined) upd.billDate = b.billDate;
    if (b.fromDate !== undefined) upd.fromDate = b.fromDate;
    if (b.toDate   !== undefined) upd.toDate   = b.toDate;

    const gross    = b.grossAmount      !== undefined ? Number(b.grossAmount)      : Number(cur.grossAmount);
    const retPct   = b.retentionPercent !== undefined ? Number(b.retentionPercent) : Number(cur.retentionPercent);
    const prevPaid = b.previousPaid     !== undefined ? Number(b.previousPaid)     : Number(cur.previousPaid);
    const retAmount = Math.round((gross * retPct / 100) * 100) / 100;
    const dueAmount = Math.max(0, Math.round((gross - retAmount - prevPaid) * 100) / 100);
    const vatAmount = Math.round((dueAmount * 0.15) * 100) / 100;
    const netAmount = Math.round((dueAmount + vatAmount) * 100) / 100;
    upd.grossAmount      = String(gross);
    upd.retentionPercent = String(retPct);
    upd.retentionAmount  = String(retAmount);
    upd.previousPaid     = String(prevPaid);
    upd.dueAmount        = String(dueAmount);
    upd.vatAmount        = String(vatAmount);
    upd.netAmount        = String(netAmount);
    if (b.progressPercent !== undefined) upd.progressPercent = String(b.progressPercent);
    if (b.status === "approved" && cur.status !== "approved") {
      upd.approvedAt = new Date();
      upd.approvedByUserId = req.authUser!.id;
    }
    if (b.status === "paid" && cur.status !== "paid") upd.paidAt = new Date();

    const [row] = await db.update(contractingProgressBillsTable).set(upd)
      .where(and(eq(contractingProgressBillsTable.id, id), eq(contractingProgressBillsTable.companyId, cid)))
      .returning();
    if (b.status && b.status !== cur.status) {
      await logEvent({
        companyId: cid, projectId: cur.projectId, userId: req.authUser!.id,
        eventType: b.status === "approved" ? "bill_approved" : "bill_submitted",
        title: `تحديث حالة مستخلص ${cur.billNumber} إلى ${b.status}`,
        severity: b.status === "rejected" ? "warn" : "info",
      });
    }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/bills/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(contractingProgressBillsTable)
      .where(and(eq(contractingProgressBillsTable.id, id), eq(contractingProgressBillsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── EVENTS ───────────────────
router.get("/projects/:projectId/events", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const limit = Math.min(500, Number(req.query.limit ?? 100));
    const rows = await db.select().from(contractingEventsTable)
      .where(and(
        eq(contractingEventsTable.companyId, cid),
        eq(contractingEventsTable.projectId, projectId),
      ))
      .orderBy(desc(contractingEventsTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── RISKS ───────────────────
const SCORE_MAP: Record<string, number> = { low: 1, medium: 2, high: 3 };
const calcScore = (l: string, i: string) => (SCORE_MAP[l] ?? 2) * (SCORE_MAP[i] ?? 2);

router.get("/projects/:projectId/risks", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const rows = await db.select().from(contractingRisksTable)
      .where(and(
        eq(contractingRisksTable.companyId, cid),
        eq(contractingRisksTable.projectId, projectId),
      ))
      .orderBy(desc(contractingRisksTable.score), desc(contractingRisksTable.createdAt));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/projects/:projectId/risks", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    if (!b?.title) { res.status(400).json({ error: "العنوان مطلوب" }); return; }
    const score = calcScore(b.likelihood ?? "medium", b.impact ?? "medium");
    const [row] = await db.insert(contractingRisksTable).values({
      companyId: cid, projectId,
      title: String(b.title),
      description: b.description ?? null,
      category: b.category ?? "other",
      likelihood: b.likelihood ?? "medium",
      impact: b.impact ?? "medium",
      score,
      mitigationPlan: b.mitigationPlan ?? null,
      ownerUserId: b.ownerUserId ?? null,
      status: b.status ?? "open",
    }).returning();
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "risk_added", title: `إضافة مخاطرة: ${row.title}`,
      severity: row.score >= 6 ? "warn" : "info",
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/risks/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const upd: any = { updatedAt: new Date() };
    for (const k of ["title","description","category","likelihood","impact","mitigationPlan","status"]) {
      if (b[k] !== undefined) upd[k] = b[k];
    }
    if (b.ownerUserId !== undefined) upd.ownerUserId = b.ownerUserId;
    if (b.likelihood !== undefined || b.impact !== undefined) {
      const [cur] = await db.select().from(contractingRisksTable)
        .where(and(eq(contractingRisksTable.id, id), eq(contractingRisksTable.companyId, cid)));
      if (cur) upd.score = calcScore(b.likelihood ?? cur.likelihood, b.impact ?? cur.impact);
    }
    if (b.status === "resolved" && !upd.resolvedAt) upd.resolvedAt = new Date();
    const [row] = await db.update(contractingRisksTable).set(upd)
      .where(and(eq(contractingRisksTable.id, id), eq(contractingRisksTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/risks/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(contractingRisksTable)
      .where(and(eq(contractingRisksTable.id, id), eq(contractingRisksTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── DASHBOARD ───────────────────
// Aggregated KPIs for the Contracting Dashboard. One round-trip with
// multiple count/sum SQL fragments to keep the page snappy.
router.get("/dashboard", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projects = await db.select().from(contractingProjectsTable)
      .where(eq(contractingProjectsTable.companyId, cid));
    const risks = await db.select().from(contractingRisksTable)
      .where(eq(contractingRisksTable.companyId, cid));
    const recentEvents = await db.select().from(contractingEventsTable)
      .where(eq(contractingEventsTable.companyId, cid))
      .orderBy(desc(contractingEventsTable.createdAt))
      .limit(20);

    const today = new Date();
    const totals = {
      total: projects.length,
      inProgress:  projects.filter(p => p.status === "in_progress").length,
      onHold:      projects.filter(p => p.status === "on_hold").length,
      completed:   projects.filter(p => p.status === "completed").length,
      delayed:     projects.filter(p =>
        p.status !== "completed" && p.status !== "cancelled"
        && p.plannedEndDate && new Date(p.plannedEndDate) < today
        && Number(p.progressPercent) < 100).length,
      contractValueSum: projects.reduce((s, p) => s + Number(p.contractValue), 0),
      plannedBudgetSum: projects.reduce((s, p) => s + Number(p.plannedBudget), 0),
      actualCostSum:    projects.reduce((s, p) => s + Number(p.actualCost), 0),
      avgProgress: projects.length === 0 ? 0
        : projects.reduce((s, p) => s + Number(p.progressPercent), 0) / projects.length,
    };
    const risksByStatus = {
      open:       risks.filter(r => r.status === "open").length,
      mitigating: risks.filter(r => r.status === "mitigating").length,
      resolved:   risks.filter(r => r.status === "resolved").length,
      highScore:  risks.filter(r => r.score >= 6 && r.status !== "resolved").length,
    };
    res.json({ totals, risksByStatus, recentEvents, topRisks: risks.slice(0, 5) });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

export default router;
