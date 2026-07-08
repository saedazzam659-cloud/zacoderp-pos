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
  journalEntriesTable, journalEntryLinesTable,
  companiesTable, accountsTable,
} from "@workspace/db";
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
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

function coerceBool(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "number") return v !== 0;
  return false;
}
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
    const scrapType = b.defaultScrapType === "value" ? "value" : "percent";
    const [row] = await db.insert(faCategoriesTable).values({
      companyId: cid, code, nameAr,
      nameEn: b.nameEn || null,
      defaultLifeYears: String(b.defaultLifeYears ?? 5),
      defaultDepreciationMethod: method as any,
      defaultScrapRate: String(b.defaultScrapRate ?? "10"),
      defaultScrapType: scrapType,
      costAccountId: b.costAccountId ? Number(b.costAccountId) : null,
      accumDepreciationAccountId: b.accumDepreciationAccountId ? Number(b.accumDepreciationAccountId) : null,
      depreciationExpenseAccountId: b.depreciationExpenseAccountId ? Number(b.depreciationExpenseAccountId) : null,
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
    if (b.defaultScrapType !== undefined) patch.defaultScrapType = b.defaultScrapType === "value" ? "value" : "percent";
    for (const k of ["costAccountId","accumDepreciationAccountId","depreciationExpenseAccountId"])
      if (b[k] !== undefined) patch[k] = b[k] ? Number(b[k]) : null;
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
      .where(and(
        eq(fixedAssetsTable.companyId, cid),
        // Branch scope: specific ?branchId → branch_id = X OR NULL; restricted
        // users auto-capped; admin w/o filter sees all assets.
        ...branchScopeSpread(req, fixedAssetsTable.branchId, req.query.branchId),
      )).orderBy(desc(fixedAssetsTable.id));
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
      skipAcquisitionJe: coerceBool(b.skipAcquisitionJe),
      model: b.model || null,
      brand: b.brand || null,
      serialNo: b.serialNo || null,
      serialNumber: b.serialNumber || null,
      plateNumber: b.plateNumber || null,
      color: b.color || null,
      initialKm: b.initialKm ? Number(b.initialKm) : null,
      currentKm: b.currentKm ? Number(b.currentKm) : null,
      lifeYears: String(b.lifeYears ?? 5),
      vatRate: String(b.vatRate ?? "15"),
      priceIncludesVat: coerceBool(b.priceIncludesVat),
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
    // historical balance sheet. Also skip when the user explicitly marked
    // the asset as already recorded elsewhere (manual JE / purchase invoice).
    let warning: string | null = null;
    if (!b.skipAcquisitionJe && Number(purchaseValue) > 0 && Number(accumulated) === 0) {
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
    const strFields = ["code","nameAr","nameEn","supplierName","invoiceNo","paymentMethod","model","brand","serialNo","serialNumber","plateNumber","color","insuranceCompany","insurancePolicyNo","location","notes"];
    for (const k of strFields) if (b[k] !== undefined) patch[k] = b[k] || null;
    if (b.skipAcquisitionJe !== undefined) patch.skipAcquisitionJe = coerceBool(b.skipAcquisitionJe);
    const numStrFields = ["purchaseValue","scrapValue","insuranceValue","accumulatedDepreciation","bookValue"];
    for (const k of numStrFields) if (b[k] !== undefined) patch[k] = String(b[k] || "0");
    const dateFields = ["purchaseDate","depreciationStart","insuranceStart","insuranceEnd"];
    for (const k of dateFields) if (b[k] !== undefined) patch[k] = b[k] || null;
    const intFields = ["branchId","costCenterId","categoryId","custodianEmployeeId","initialKm","currentKm","supplierId","cashBoxId","bankAccountId"];
    for (const k of intFields) if (b[k] !== undefined) patch[k] = b[k] ? Number(b[k]) : null;
    if (b.lifeYears !== undefined) patch.lifeYears = String(b.lifeYears || 5);
    if (b.vatRate !== undefined) patch.vatRate = String(b.vatRate || "15");
    if (b.priceIncludesVat !== undefined) patch.priceIncludesVat = coerceBool(b.priceIncludesVat);
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
    const [asset] = await db.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.id, assetId), eq(fixedAssetsTable.companyId, cid)));
    if (!asset) { res.status(400).json({ error: "الأصل غير موجود" }); return; }
    const oldCostCenterId = asset.costCenterId ?? null;
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

    // ── Reallocate module-generated depreciation cost center ─────────────────
    // When the asset moves to a NEW cost center, re-tag the cost center on the
    // depreciation journal entries the module itself generated for periods on
    // or after the transfer date (edit-in-place). Closed accounting periods are
    // skipped (never mutated) and reported back so the UI can notify the user.
    // Manual JEs entered by hand are NOT linked to depreciation runs → untouched.
    let reallocated = 0, skipped = 0;
    const newCcId = b.toCostCenterId ? Number(b.toCostCenterId) : null;
    if (newCcId && newCcId !== oldCostCenterId) {
      const newCc = String(newCcId);
      const oldCc = oldCostCenterId != null ? String(oldCostCenterId) : null;
      const transferDate = row.transferDate; // YYYY-MM-DD
      const runs = await db.select().from(faDepreciationRunsTable)
        .where(and(eq(faDepreciationRunsTable.assetId, assetId), eq(faDepreciationRunsTable.companyId, cid)));
      for (const run of runs) {
        if (!run.journalEntryId) continue;
        const [je] = await db.select().from(journalEntriesTable)
          .where(and(eq(journalEntriesTable.id, run.journalEntryId), eq(journalEntriesTable.companyId, cid)));
        if (!je || !je.entryDate) continue;
        if (je.entryDate < transferDate) continue; // only from the transfer date onward
        const w = await assertWritableForDate(cid, je.entryDate);
        if (!w.ok) { skipped++; continue; }        // closed period → skip + notify
        await db.update(journalEntryLinesTable)
          .set({ costCenter: newCc })
          .where(and(
            eq(journalEntryLinesTable.entryId, je.id),
            oldCc ? eq(journalEntryLinesTable.costCenter, oldCc) : isNull(journalEntryLinesTable.costCenter),
          ));
        reallocated++;
      }
    }

    res.status(201).json({ ...row, reallocated, skipped });
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

// ════════════════════════════════════════════════════════════════════════
// MOVEMENT SCHEDULE REPORT  (جدول الإهلاك / حركة الأصول الثابتة)
// GL-driven asset movement schedule grouped by the COA asset-cost account.
// Rows are individual registered assets; any posted GL movement on the same
// cost / accumulated-depreciation accounts NOT explained by a registered
// asset (assets booked via purchase invoices or manual journal entries) is
// surfaced as a reconciliation "غير مربوطة بأصل" row so the report always ties
// to the general ledger. Posted JEs only (status='posted'). Branch-scoped.
// ════════════════════════════════════════════════════════════════════════
router.get("/reports/movement-schedule", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;

    const d10 = (s: any) => (s == null ? "" : String(s).slice(0, 10));
    const r2  = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
    const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const today = new Date().toISOString().slice(0, 10);
    const rawFrom = d10(req.query.from);
    const rawTo   = d10(req.query.to);
    if ((rawFrom && !isIso(rawFrom)) || (rawTo && !isIso(rawTo))) {
      res.status(400).json({ error: "صيغة التاريخ غير صحيحة (YYYY-MM-DD)" });
      return;
    }
    let from = rawFrom || `${today.slice(0, 4)}-01-01`;
    let to   = rawTo   || today;
    if (from > to) { const t = from; from = to; to = t; }
    const fromYm = Number(from.slice(0, 4)) * 12 + (Number(from.slice(5, 7)) - 1);
    const toYm   = Number(to.slice(0, 4))   * 12 + (Number(to.slice(5, 7))   - 1);

    const [company] = await db.select({
      cost:  companiesTable.faAssetCostAccountId,
      accum: companiesTable.faAccumDepreciationAccountId,
    }).from(companiesTable).where(eq(companiesTable.id, cid));
    const defCost  = company?.cost  ?? null;
    const defAccum = company?.accum ?? null;

    const [cats, accounts, assets, disposals, runs] = await Promise.all([
      db.select().from(faCategoriesTable).where(eq(faCategoriesTable.companyId, cid)),
      db.select({ id: accountsTable.id, code: accountsTable.code, nameAr: accountsTable.nameAr })
        .from(accountsTable).where(eq(accountsTable.companyId, cid)),
      db.select().from(fixedAssetsTable)
        .where(and(eq(fixedAssetsTable.companyId, cid),
          ...branchScopeSpread(req, fixedAssetsTable.branchId, req.query.branchId))),
      db.select().from(faDisposalsTable).where(eq(faDisposalsTable.companyId, cid)),
      db.select().from(faDepreciationRunsTable).where(eq(faDepreciationRunsTable.companyId, cid)),
    ]);

    const acctMap = new Map<number, { code: string; name: string }>();
    for (const a of accounts) acctMap.set(a.id, { code: a.code, name: a.nameAr });

    const catMap = new Map<number, { cost: number | null; accum: number | null }>();
    for (const c of cats) catMap.set(c.id, {
      cost:  c.costAccountId ?? null,
      accum: c.accumDepreciationAccountId ?? null,
    });

    const disposalByAsset = new Map<number, any>();
    for (const d of disposals) if (!disposalByAsset.has(d.assetId)) disposalByAsset.set(d.assetId, d);

    const runsByAsset = new Map<number, any[]>();
    for (const r of runs) {
      const arr = runsByAsset.get(r.assetId) || [];
      arr.push(r); runsByAsset.set(r.assetId, arr);
    }

    // Account sets + accum→cost group mapping. An accum account can be SHARED by
    // several cost accounts (a common COA where all assets use one مجمع الإهلاك),
    // so map one-to-many + remember a deterministic "primary" cost group per accum
    // for attributing the leftover (unlinked) depreciation residual.
    const costAccountIds  = new Set<number>();
    const accumAccountIds = new Set<number>();
    const accumToCosts    = new Map<number, Set<number>>();
    const accumPrimaryCost = new Map<number, number>();
    const linkAccumCost = (accumId: number | null, costId: number | null) => {
      if (accumId == null || costId == null) return;
      let s = accumToCosts.get(accumId);
      if (!s) { s = new Set<number>(); accumToCosts.set(accumId, s); }
      s.add(costId);
      if (!accumPrimaryCost.has(accumId)) accumPrimaryCost.set(accumId, costId);
    };
    if (defCost  != null) costAccountIds.add(defCost);
    if (defAccum != null) accumAccountIds.add(defAccum);
    linkAccumCost(defAccum, defCost);
    for (const c of cats) {
      if (c.costAccountId != null) costAccountIds.add(c.costAccountId);
      if (c.accumDepreciationAccountId != null) accumAccountIds.add(c.accumDepreciationAccountId);
      linkAccumCost(c.accumDepreciationAccountId ?? null, c.costAccountId ?? null);
    }

    // Posted GL lines on all FA accounts, branch-scoped
    const allAcctIds = [...new Set<number>([...costAccountIds, ...accumAccountIds])];
    let glLines: any[] = [];
    if (allAcctIds.length) {
      glLines = await db.select({
        accountId: journalEntryLinesTable.accountId,
        debit:     journalEntryLinesTable.debit,
        credit:    journalEntryLinesTable.credit,
        entryDate: journalEntriesTable.entryDate,
      }).from(journalEntryLinesTable)
        .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
        .where(and(
          eq(journalEntriesTable.companyId, cid),
          eq(journalEntriesTable.status, "posted"),
          inArray(journalEntryLinesTable.accountId, allAcctIds),
          ...branchScopeSpread(req, journalEntriesTable.branchId, req.query.branchId),
        ));
    }
    const glByAcct = new Map<number, { openNet: number; drIn: number; crIn: number }>();
    const getGl = (id: number) => {
      let g = glByAcct.get(id);
      if (!g) { g = { openNet: 0, drIn: 0, crIn: 0 }; glByAcct.set(id, g); }
      return g;
    };
    for (const l of glLines) {
      if (l.accountId == null) continue;
      const dt = d10(l.entryDate);
      const dr = Number(l.debit || 0), cr = Number(l.credit || 0);
      const g = getGl(l.accountId);
      if (dt < from) g.openNet += dr - cr;      // signed net (debit-positive)
      else if (dt <= to) { g.drIn += dr; g.crIn += cr; }
    }

    const methodLabel: Record<string, string> = {
      straight_line: "القسط الثابت",
      declining_balance: "القسط المتناقص",
      units_of_production: "وحدات الإنتاج",
    };

    type Move = { opening: number; additions: number; exclusions: number };
    interface Group {
      accountId: number | null; accountCode: string; accountName: string;
      rows: any[]; regCost: Move; regDep: Move;
    }
    const groups = new Map<number, Group>();
    const groupFor = (costId: number | null): Group => {
      const key = costId ?? -1;
      let g = groups.get(key);
      if (!g) {
        const info = costId != null ? acctMap.get(costId) : undefined;
        g = {
          accountId: costId,
          accountCode: info?.code ?? "—",
          accountName: info?.name ?? "أصول غير مصنّفة",
          rows: [],
          regCost: { opening: 0, additions: 0, exclusions: 0 },
          regDep:  { opening: 0, additions: 0, exclusions: 0 },
        };
        groups.set(key, g);
      }
      return g;
    };
    for (const id of costAccountIds) groupFor(id);

    for (const a of assets) {
      const cat = a.categoryId != null ? catMap.get(a.categoryId) : undefined;
      const costId = cat?.cost ?? defCost;
      const pv = Number(a.purchaseValue || 0);
      const acqDate = d10(a.purchaseDate);
      const disp = disposalByAsset.get(a.id);
      const dispDate = disp ? d10(disp.disposalDate) : "";

      const acquiredBefore   = !!acqDate && acqDate < from;
      const acquiredInPeriod = !!acqDate && acqDate >= from && acqDate <= to;
      const disposedBefore   = !!dispDate && dispDate < from;
      const disposedInPeriod = !!dispDate && dispDate >= from && dispDate <= to;
      if (disposedBefore) continue;

      const cost: Move = { opening: 0, additions: 0, exclusions: 0 };
      if (acquiredBefore && !disposedBefore) cost.opening = pv;
      if (acquiredInPeriod) cost.additions = pv;
      if (disposedInPeriod) cost.exclusions = pv;
      const costClosing = cost.opening + cost.additions - cost.exclusions;

      const aRuns = runsByAsset.get(a.id) || [];
      let runsBefore = 0, runsWithin = 0, runsAll = 0;
      for (const r of aRuns) {
        const ym = Number(r.periodYear) * 12 + (Number(r.periodMonth) - 1);
        const amt = Number(r.depreciationAmount || 0);
        runsAll += amt;
        if (ym < fromYm) runsBefore += amt;
        else if (ym <= toYm) runsWithin += amt;
      }
      const curAccum = Number(a.accumulatedDepreciation || 0);
      const openingBalanceAccum = Math.max(0, curAccum - runsAll); // opening-balance load, not tracked by runs
      const dep: Move = { opening: 0, additions: 0, exclusions: 0 };
      dep.opening   = runsBefore + (acquiredBefore ? openingBalanceAccum : 0);
      dep.additions = runsWithin;
      if (disposedInPeriod) dep.exclusions = dep.opening + dep.additions; // full accum removed → closing 0
      const depClosing = dep.opening + dep.additions - dep.exclusions;

      if (cost.opening === 0 && cost.additions === 0 && cost.exclusions === 0 &&
          dep.opening === 0 && dep.additions === 0 && dep.exclusions === 0) continue;

      const g = groupFor(costId ?? null);
      g.regCost.opening += cost.opening; g.regCost.additions += cost.additions; g.regCost.exclusions += cost.exclusions;
      g.regDep.opening  += dep.opening;  g.regDep.additions  += dep.additions;  g.regDep.exclusions  += dep.exclusions;

      const life = Number(a.lifeYears || 0);
      g.rows.push({
        kind: "asset",
        assetId: a.id, code: a.code, name: a.nameAr,
        status: a.status,
        acquisitionDate: acqDate || null,
        depreciationStart: d10(a.depreciationStart) || null,
        method: a.depreciationMethod,
        methodLabel: methodLabel[a.depreciationMethod] ?? a.depreciationMethod,
        lifeYears: life || null,
        rate: life > 0 ? r2(100 / life) : null,
        cost: { opening: r2(cost.opening), additions: r2(cost.additions), exclusions: r2(cost.exclusions), closing: r2(costClosing) },
        dep:  { opening: r2(dep.opening),  additions: r2(dep.additions),  exclusions: r2(dep.exclusions),  closing: r2(depClosing) },
        bookValue: r2(costClosing - depClosing),
      });
    }

    // Reconciliation: GL movement not explained by registered assets.
    // Depreciation side is computed PER ACCUM ACCOUNT (not per cost group): a shared
    // accum account's GL movement minus the registered dep of EVERY cost group that
    // uses it is the true "unlinked" residual, attributed once to that accum's
    // primary cost group. Doing it per-group (old code) double-subtracted regDep and
    // made non-primary groups show a spurious negative depreciation.
    const eps = 0.005;
    const hasMove = (m: Move) => Math.abs(m.opening) > eps || Math.abs(m.additions) > eps || Math.abs(m.exclusions) > eps;

    const uDepByGroup = new Map<number, Move>();
    const ensureUDep = (costId: number): Move => {
      let m = uDepByGroup.get(costId);
      if (!m) { m = { opening: 0, additions: 0, exclusions: 0 }; uDepByGroup.set(costId, m); }
      return m;
    };
    for (const accumId of accumAccountIds) {
      const glA = glByAcct.get(accumId) || { openNet: 0, drIn: 0, crIn: 0 };
      const move: Move = { opening: -glA.openNet, additions: glA.crIn, exclusions: glA.drIn }; // accum is credit-natured
      const costSet = accumToCosts.get(accumId);
      if (costSet) {
        for (const costId of costSet) {
          const g = groups.get(costId);
          if (!g) continue;
          move.opening    -= g.regDep.opening;
          move.additions  -= g.regDep.additions;
          move.exclusions -= g.regDep.exclusions;
        }
      }
      let targetCostId = accumPrimaryCost.get(accumId) ?? null;
      if (targetCostId == null || !groups.has(targetCostId)) {
        targetCostId = costSet && costSet.size ? [...costSet].find(id => groups.has(id)) ?? null : null;
      }
      if (targetCostId == null) targetCostId = defCost != null && groups.has(defCost) ? defCost : -1;
      const m = ensureUDep(targetCostId);
      m.opening    += move.opening;
      m.additions  += move.additions;
      m.exclusions += move.exclusions;
    }

    for (const g of groups.values()) {
      if (g.accountId == null) continue;
      const glCost = glByAcct.get(g.accountId) || { openNet: 0, drIn: 0, crIn: 0 };
      const uCost: Move = {
        opening:    glCost.openNet - g.regCost.opening,
        additions:  glCost.drIn    - g.regCost.additions,
        exclusions: glCost.crIn    - g.regCost.exclusions,
      };
      const uDep: Move = uDepByGroup.get(g.accountId) ?? { opening: 0, additions: 0, exclusions: 0 };

      if (hasMove(uCost) || hasMove(uDep)) {
        const cClose = uCost.opening + uCost.additions - uCost.exclusions;
        const dClose = uDep.opening + uDep.additions - uDep.exclusions;
        g.rows.push({
          kind: "unlinked",
          assetId: null, code: "—", name: "حركات غير مربوطة بأصل (قيود/فواتير)",
          status: null, acquisitionDate: null, depreciationStart: null,
          method: null, methodLabel: null, lifeYears: null, rate: null,
          cost: { opening: r2(uCost.opening), additions: r2(uCost.additions), exclusions: r2(uCost.exclusions), closing: r2(cClose) },
          dep:  { opening: r2(uDep.opening),  additions: r2(uDep.additions),  exclusions: r2(uDep.exclusions),  closing: r2(dClose) },
          bookValue: r2(cClose - dClose),
        });
      }
    }

    const zero = () => ({ opening: 0, additions: 0, exclusions: 0, closing: 0 });
    const grand = { cost: zero(), dep: zero(), bookValue: 0 };
    const serialized = [...groups.values()]
      .filter(g => g.rows.length > 0)
      .sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode), "ar"))
      .map(g => {
        const gt = { cost: zero(), dep: zero(), bookValue: 0 };
        for (const r of g.rows) {
          for (const k of ["opening", "additions", "exclusions", "closing"] as const) {
            gt.cost[k] += r.cost[k]; gt.dep[k] += r.dep[k];
          }
          gt.bookValue += r.bookValue;
        }
        for (const k of ["opening", "additions", "exclusions", "closing"] as const) {
          gt.cost[k] = r2(gt.cost[k]); gt.dep[k] = r2(gt.dep[k]);
          grand.cost[k] = r2(grand.cost[k] + gt.cost[k]); grand.dep[k] = r2(grand.dep[k] + gt.dep[k]);
        }
        gt.bookValue = r2(gt.bookValue);
        grand.bookValue = r2(grand.bookValue + gt.bookValue);
        return { accountId: g.accountId, accountCode: g.accountCode, accountName: g.accountName, rows: g.rows, totals: gt };
      });

    res.json({ from, to, groups: serialized, totals: grand });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
