// ─────────────────────────────────────────────────────────────────────────
// Fixed Assets module — Categories, Assets, Maintenance log, Transfers,
// Depreciation runs, Disposals. Multi-tenant (companyId scoped). RBAC gate:
// module key "fixed_assets".
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  fixedAssetsTable, faCategoriesTable, faMaintenanceTable, faTransfersTable,
  faDepreciationRunsTable, faDisposalsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import {
  buildAcquisitionJournal,
  buildDepreciationRunJournal,
  buildDisposalJournal,
} from "../lib/fa-journals.js";
import { postDepreciationForCompany } from "../lib/depreciationPosting.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("fixed_assets"));
router.use(moduleAudit("fixed_assets"));
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

const STATUSES   = ["active","in_maintenance","transferred","sold","scrapped","fully_depreciated"] as const;
const MNT_TYPES  = ["periodic","emergency","preventive","corrective"] as const;
const DEP_METHODS = ["straight_line","declining_balance","units_of_production"] as const;
const DISP_TYPES = ["sale","scrap","full_depreciation","write_off"] as const;

// ════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ════════════════════════════════════════════════════════════════════════
router.get("/categories", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(faCategoriesTable)
      .where(eq(faCategoriesTable.companyId, cid)).orderBy(desc(faCategoriesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/categories", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم الفئة مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, faCategoriesTable, "FAC");
    const method = (DEP_METHODS as readonly string[]).includes(b.defaultDepreciationMethod) ? b.defaultDepreciationMethod : "straight_line";
    const [row] = await db.insert(faCategoriesTable).values({
      companyId: cid, code, nameAr,
      nameEn: b.nameEn || null,
      defaultLifeYears: Number(b.defaultLifeYears ?? 5),
      defaultDepreciationMethod: method as any,
      defaultScrapRate: String(b.defaultScrapRate ?? "10"),
      isActive: b.isActive !== false,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/categories/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, faCategoriesTable, id, cid, "الفئة")) return;
    const b = req.body ?? {};
    const patch: any = {};
    for (const k of ["code","nameAr","nameEn"]) if (b[k] !== undefined) patch[k] = b[k] || null;
    if (b.defaultLifeYears !== undefined) patch.defaultLifeYears = Number(b.defaultLifeYears || 5);
    if (b.defaultScrapRate !== undefined) patch.defaultScrapRate = String(b.defaultScrapRate || "0");
    if (b.isActive !== undefined) patch.isActive = !!b.isActive;
    if ((DEP_METHODS as readonly string[]).includes(b.defaultDepreciationMethod)) patch.defaultDepreciationMethod = b.defaultDepreciationMethod;
    const [row] = await db.update(faCategoriesTable).set(patch)
      .where(and(eq(faCategoriesTable.id, id), eq(faCategoriesTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/categories/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, faCategoriesTable, id, cid, "الفئة")) return;
    await db.delete(faCategoriesTable).where(and(eq(faCategoriesTable.id, id), eq(faCategoriesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// ASSETS
// ════════════════════════════════════════════════════════════════════════
router.get("/assets", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(fixedAssetsTable)
      .where(eq(fixedAssetsTable.companyId, cid)).orderBy(desc(fixedAssetsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/assets", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const nameAr = String(b.nameAr ?? "").trim();
    if (!nameAr) { res.status(400).json({ error: "اسم الأصل مطلوب" }); return; }
    const code = String(b.code ?? "").trim() || await nextSequenceOrFallback(
      cid,
      "fixed_asset",
      { userId: (req as any).authUser?.id ?? null, refTable: "fixed_assets", branchId: b.branchId ? Number(b.branchId) : null },
      () => nextCode(cid, fixedAssetsTable, "AST"),
    );
    const status = (STATUSES as readonly string[]).includes(b.status) ? b.status : "active";
    const method = (DEP_METHODS as readonly string[]).includes(b.depreciationMethod) ? b.depreciationMethod : "straight_line";
    const purchaseValue = String(b.purchaseValue ?? "0");
    const scrapValue    = String(b.scrapValue ?? "0");
    const accumulated   = String(b.accumulatedDepreciation ?? "0");
    const bookValue     = String(b.bookValue ?? (Number(purchaseValue) - Number(accumulated)));
    const qrPayload     = JSON.stringify({ kind: "fixed_asset", code, name: nameAr, companyId: cid });
    const [row] = await db.insert(fixedAssetsTable).values({
      companyId: cid,
      branchId: b.branchId ? Number(b.branchId) : null,
      costCenterId: b.costCenterId ? Number(b.costCenterId) : null,
      categoryId: b.categoryId ? Number(b.categoryId) : null,
      code, nameAr,
      nameEn: b.nameEn || null,
      status: status as any,
      purchaseDate: b.purchaseDate || null,
      purchaseValue,
      supplierName: b.supplierName || null,
      supplierId: b.supplierId ? Number(b.supplierId) : null,
      invoiceNo: b.invoiceNo || null,
      paymentMethod: b.paymentMethod || null,
      cashBoxId: b.cashBoxId ? Number(b.cashBoxId) : null,
      bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      model: b.model || null,
      brand: b.brand || null,
      serialNo: b.serialNo || null,
      plateNumber: b.plateNumber || null,
      color: b.color || null,
      initialKm: b.initialKm ? Number(b.initialKm) : null,
      currentKm: b.currentKm ? Number(b.currentKm) : null,
      lifeYears: Number(b.lifeYears ?? 5),
      depreciationMethod: method as any,
      scrapValue,
      depreciationStart: b.depreciationStart || null,
      accumulatedDepreciation: accumulated,
      bookValue,
      insuranceCompany: b.insuranceCompany || null,
      insurancePolicyNo: b.insurancePolicyNo || null,
      insuranceStart: b.insuranceStart || null,
      insuranceEnd: b.insuranceEnd || null,
      insuranceValue: String(b.insuranceValue ?? "0"),
      custodianEmployeeId: b.custodianEmployeeId ? Number(b.custodianEmployeeId) : null,
      location: b.location || null,
      qrPayload,
      notes: b.notes || null,
    }).returning();
    // ── Phase-2: post acquisition JE if this is a fresh purchase (cost > 0
    // and no opening accumulated depreciation). Skipping when the user is
    // loading an opening-balance asset prevents double-counting against the
    // historical balance sheet.
    let warning: string | null = null;
    if (Number(purchaseValue) > 0 && Number(accumulated) === 0) {
      try {
        await buildAcquisitionJournal(cid, row.id, {
          cashBoxId:    b.paymentMethod === "cash" && b.cashBoxId    ? Number(b.cashBoxId)    : null,
          bankAccountId: b.paymentMethod === "bank" && b.bankAccountId ? Number(b.bankAccountId) : null,
          supplierId:   b.paymentMethod === "credit" && b.supplierId  ? Number(b.supplierId)   : null,
        });
      } catch (e: any) {
        warning = e.message ?? "تعذّر إنشاء قيد الاقتناء";
      }
    }
    res.status(201).json(warning ? { ...row, warning } : row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/assets/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, fixedAssetsTable, id, cid, "الأصل")) return;
    const b = req.body ?? {};
    const patch: any = { updatedAt: new Date() };
    const strFields = ["code","nameAr","nameEn","supplierName","invoiceNo","paymentMethod","model","brand","serialNo","plateNumber","color","insuranceCompany","insurancePolicyNo","location","notes"];
    for (const k of strFields) if (b[k] !== undefined) patch[k] = b[k] || null;
    const numStrFields = ["purchaseValue","scrapValue","insuranceValue","accumulatedDepreciation","bookValue"];
    for (const k of numStrFields) if (b[k] !== undefined) patch[k] = String(b[k] || "0");
    const dateFields = ["purchaseDate","depreciationStart","insuranceStart","insuranceEnd"];
    for (const k of dateFields) if (b[k] !== undefined) patch[k] = b[k] || null;
    const intFields = ["branchId","costCenterId","categoryId","custodianEmployeeId","initialKm","currentKm","supplierId","cashBoxId","bankAccountId"];
    for (const k of intFields) if (b[k] !== undefined) patch[k] = b[k] ? Number(b[k]) : null;
    if (b.lifeYears !== undefined) patch.lifeYears = Number(b.lifeYears || 5);
    if ((STATUSES as readonly string[]).includes(b.status)) patch.status = b.status;
    if ((DEP_METHODS as readonly string[]).includes(b.depreciationMethod)) patch.depreciationMethod = b.depreciationMethod;
    const [row] = await db.update(fixedAssetsTable).set(patch)
      .where(and(eq(fixedAssetsTable.id, id), eq(fixedAssetsTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/assets/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, fixedAssetsTable, id, cid, "الأصل")) return;
    await db.delete(fixedAssetsTable).where(and(eq(fixedAssetsTable.id, id), eq(fixedAssetsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ════════════════════════════════════════════════════════════════════════
router.get("/maintenance", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(faMaintenanceTable)
      .where(eq(faMaintenanceTable.companyId, cid)).orderBy(desc(faMaintenanceTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/maintenance", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const assetId = Number(b.assetId);
    if (!await ownsRow(fixedAssetsTable, assetId, cid)) { res.status(400).json({ error: "الأصل غير موجود" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, faMaintenanceTable, "FAM");
    const type = (MNT_TYPES as readonly string[]).includes(b.type) ? b.type : "periodic";
    const [row] = await db.insert(faMaintenanceTable).values({
      companyId: cid, assetId, code,
      type: type as any,
      serviceDate: b.serviceDate || new Date().toISOString().slice(0, 10),
      cost: String(b.cost ?? "0"),
      vendorName: b.vendorName || null,
      technicianName: b.technicianName || null,
      description: b.description || null,
      kmAtService: b.kmAtService ? Number(b.kmAtService) : null,
      approved: !!b.approved,
      notes: b.notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/maintenance/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, faMaintenanceTable, id, cid, "سجل الصيانة")) return;
    const b = req.body ?? {};
    const patch: any = {};
    for (const k of ["code","vendorName","technicianName","description","notes"]) if (b[k] !== undefined) patch[k] = b[k] || null;
    if (b.cost !== undefined) patch.cost = String(b.cost || "0");
    if (b.serviceDate !== undefined) patch.serviceDate = b.serviceDate;
    if (b.kmAtService !== undefined) patch.kmAtService = b.kmAtService ? Number(b.kmAtService) : null;
    if (b.approved !== undefined) patch.approved = !!b.approved;
    if ((MNT_TYPES as readonly string[]).includes(b.type)) patch.type = b.type;
    const [row] = await db.update(faMaintenanceTable).set(patch)
      .where(and(eq(faMaintenanceTable.id, id), eq(faMaintenanceTable.companyId, cid))).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/maintenance/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, faMaintenanceTable, id, cid, "سجل الصيانة")) return;
    await db.delete(faMaintenanceTable).where(and(eq(faMaintenanceTable.id, id), eq(faMaintenanceTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// TRANSFERS
// ════════════════════════════════════════════════════════════════════════
router.get("/transfers", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(faTransfersTable)
      .where(eq(faTransfersTable.companyId, cid)).orderBy(desc(faTransfersTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/transfers", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const assetId = Number(b.assetId);
    if (!await ownsRow(fixedAssetsTable, assetId, cid)) { res.status(400).json({ error: "الأصل غير موجود" }); return; }
    const code = String(b.code ?? "").trim() || await nextCode(cid, faTransfersTable, "FAT");
    const [row] = await db.insert(faTransfersTable).values({
      companyId: cid, assetId, code,
      fromBranchId: b.fromBranchId ? Number(b.fromBranchId) : null,
      toBranchId: b.toBranchId ? Number(b.toBranchId) : null,
      fromCostCenterId: b.fromCostCenterId ? Number(b.fromCostCenterId) : null,
      toCostCenterId: b.toCostCenterId ? Number(b.toCostCenterId) : null,
      transferDate: b.transferDate || new Date().toISOString().slice(0, 10),
      reason: b.reason || null,
      approvedBy: b.approvedBy || null,
      notes: b.notes || null,
    }).returning();
    // Update asset branch / cost center
    if (b.toBranchId || b.toCostCenterId) {
      const upd: any = { updatedAt: new Date(), status: "transferred" };
      if (b.toBranchId)     upd.branchId     = Number(b.toBranchId);
      if (b.toCostCenterId) upd.costCenterId = Number(b.toCostCenterId);
      await db.update(fixedAssetsTable).set(upd)
        .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
    }
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/transfers/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, faTransfersTable, id, cid, "سجل النقل")) return;
    await db.delete(faTransfersTable).where(and(eq(faTransfersTable.id, id), eq(faTransfersTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// DEPRECIATION RUNS
// ════════════════════════════════════════════════════════════════════════
router.get("/depreciation/runs", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(faDepreciationRunsTable)
      .where(eq(faDepreciationRunsTable.companyId, cid)).orderBy(desc(faDepreciationRunsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Compute monthly depreciation preview for all active assets without posting.
router.get("/depreciation/preview", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const assets = await db.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.companyId, cid), eq(fixedAssetsTable.status, "active" as any)));
    const out = assets.map(a => {
      const purchase = Number(a.purchaseValue || 0);
      const scrap    = Number(a.scrapValue || 0);
      const accum    = Number(a.accumulatedDepreciation || 0);
      const years    = Math.max(1/12, Number(a.lifeYears || 1));
      const months   = Math.max(1, Math.round(years * 12));
      const method   = String(a.depreciationMethod || "straight_line");
      const book     = Math.max(scrap, purchase - accum);
      let monthly: number;
      if (method === "declining_balance") {
        // Double-declining balance, monthly: rate = 2 / lifeYears, monthly = book * rate / 12
        monthly = (book * (2 / years)) / 12;
      } else {
        // straight_line (and fallback for units_of_production until usage tracking added)
        monthly = (purchase - scrap) / months;
      }
      const remaining = Math.max(0, purchase - scrap - accum);
      const apply    = Math.min(monthly, remaining);
      return {
        id: a.id, code: a.code, nameAr: a.nameAr,
        purchaseValue: purchase, scrapValue: scrap,
        accumulatedDepreciation: accum,
        bookValue: book,
        method,
        monthlyDepreciation: Number(monthly.toFixed(2)),
        applicable: Number(apply.toFixed(2)),
      };
    });
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Manually trigger the auto-depreciation scheduler sweep across ALL active
// companies. Reserved for SuperAdmin — useful for testing the schedule
// without waiting for the next hourly tick. The scheduler is idempotent so
// this is always safe to run.
router.post("/depreciation/run-auto-now", async (req, res) => {
  try {
    if (req.authUser?.role !== "superadmin") {
      res.status(403).json({ error: "للمدير العام فقط" }); return;
    }
    const mod = await import("../lib/depreciationScheduler.js");
    const summary = await mod.runAutoDepreciationSweep();
    res.json(summary);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Post monthly depreciation for one period — body { periodMonth, periodYear }.
router.post("/depreciation/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const now = new Date();
    const month = Number(b.periodMonth ?? (now.getMonth() + 1));
    const year  = Number(b.periodYear  ?? now.getFullYear());
    const out = await postDepreciationForCompany(
      cid, month, year, req.authUser?.username || null,
    );
    res.status(201).json(out);
  } catch (e: any) {
    const msg = e?.message || "خطأ غير معروف";
    const code = msg === "فترة غير صالحة" ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

// ════════════════════════════════════════════════════════════════════════
// DISPOSALS
// ════════════════════════════════════════════════════════════════════════
router.get("/disposals", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select().from(faDisposalsTable)
      .where(eq(faDisposalsTable.companyId, cid)).orderBy(desc(faDisposalsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/disposals", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const assetId = Number(b.assetId);
    if (!await ownsRow(fixedAssetsTable, assetId, cid)) { res.status(400).json({ error: "الأصل غير موجود" }); return; }
    const [asset] = await db.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
    if (!asset) { res.status(404).json({ error: "الأصل غير موجود" }); return; }
    const type = (DISP_TYPES as readonly string[]).includes(b.type) ? b.type : "sale";
    const code = String(b.code ?? "").trim() || await nextCode(cid, faDisposalsTable, "FAD");
    const sale  = Number(b.salePrice  ?? 0);
    const scrap = Number(b.scrapValue ?? 0);
    const book  = Number(asset.bookValue || 0);
    const proceeds = type === "sale" ? sale : type === "scrap" ? scrap : 0;
    const gainLoss = Number((proceeds - book).toFixed(2));
    const newStatus = type === "sale" ? "sold"
                    : type === "scrap" ? "scrapped"
                    : type === "full_depreciation" ? "fully_depreciated"
                    : "scrapped";
    const [row] = await db.insert(faDisposalsTable).values({
      companyId: cid, assetId, code,
      type: type as any,
      disposalDate: b.disposalDate || new Date().toISOString().slice(0, 10),
      salePrice: String(sale),
      scrapValue: String(scrap),
      bookValueAtDisposal: String(book.toFixed(2)),
      gainLoss: String(gainLoss),
      buyerName: b.buyerName || null,
      reason: b.reason || null,
      notes: b.notes || null,
    }).returning();
    await db.update(fixedAssetsTable).set({
      status: newStatus as any,
      updatedAt: new Date(),
    }).where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
    // ── Phase-2: post the disposal JE. Sale proceeds settled to the
    // supplied cashBoxId / bankAccountId; otherwise they go to the
    // acquisition-clearing waiting account.
    let warning: string | null = null;
    try {
      await buildDisposalJournal(cid, row.id, {
        cashBoxId:    b.cashBoxId    ? Number(b.cashBoxId)    : null,
        bankAccountId: b.bankAccountId ? Number(b.bankAccountId) : null,
      });
    } catch (e: any) {
      warning = e.message ?? "تعذّر إنشاء قيد الاستبعاد";
    }
    res.status(201).json(warning ? { ...row, warning } : row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/disposals/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    if (!await assertOwn(res, faDisposalsTable, id, cid, "سجل التخلص")) return;
    await db.delete(faDisposalsTable).where(and(eq(faDisposalsTable.id, id), eq(faDisposalsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// SUMMARY (dashboard)
// ════════════════════════════════════════════════════════════════════════
router.get("/summary", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const [assets, maint, transfers, disposals, runs] = await Promise.all([
      db.select().from(fixedAssetsTable).where(eq(fixedAssetsTable.companyId, cid)),
      db.select().from(faMaintenanceTable).where(eq(faMaintenanceTable.companyId, cid)),
      db.select().from(faTransfersTable).where(eq(faTransfersTable.companyId, cid)),
      db.select().from(faDisposalsTable).where(eq(faDisposalsTable.companyId, cid)),
      db.select().from(faDepreciationRunsTable).where(eq(faDepreciationRunsTable.companyId, cid)),
    ]);
    const totalPurchase = assets.reduce((s, a) => s + Number(a.purchaseValue || 0), 0);
    const totalBookValue = assets.reduce((s, a) => s + Number(a.bookValue || 0), 0);
    const totalAccum     = assets.reduce((s, a) => s + Number(a.accumulatedDepreciation || 0), 0);
    const totalMaintCost = maint.reduce((s, m) => s + Number(m.cost || 0), 0);
    const today = new Date();
    const expiringInsurance = assets.filter(a => {
      if (!a.insuranceEnd) return false;
      const end = new Date(a.insuranceEnd);
      const daysLeft = Math.ceil((end.getTime() - today.getTime()) / 86_400_000);
      return daysLeft >= 0 && daysLeft <= 30;
    }).length;
    const byStatus: Record<string, number> = {};
    for (const a of assets) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    res.json({
      totalAssets: assets.length,
      totalPurchase, totalBookValue, totalAccumulatedDepreciation: totalAccum,
      totalMaintenanceCost: totalMaintCost,
      maintenanceCount: maint.length,
      transfersCount:   transfers.length,
      disposalsCount:   disposals.length,
      depreciationRuns: runs.length,
      expiringInsurance,
      byStatus,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
