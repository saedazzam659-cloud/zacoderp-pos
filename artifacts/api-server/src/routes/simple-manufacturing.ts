// Compact manufacturing facade.
//
// This router is deliberately not mounted through /production and never
// broadens the advanced production gate. It exposes only the single-screen
// operations needed by a tenant that enabled `simple_manufacturing`, while
// delegating order creation/detail/status to the same production handlers and
// tables used by the advanced UI.
import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  itemsTable,
  unitsTable,
  warehousesTable,
  productionOrdersTable,
  productionCostAllocationsTable,
  productionWizardTemplatesTable,
  bomTemplatesTable,
  bomTemplateLinesTable,
  productionRoutingsTable,
  productionRoutingStagesTable,
  workCentersTable,
  branchesTable,
  suppliersTable,
  accountsTable,
  manufacturingSettingsTable,
  productionResourcesTable,
  usersTable,
} from "@workspace/db";
import {
  extractAuth,
  resolveCompanyId,
  effectiveBranchCondition,
  intersectBranchRequest,
} from "../middleware/auth.js";
import {
  requireModulePermission,
  requirePermission,
  moduleAudit,
} from "../middleware/permissions.js";
import { setContextModuleKey } from "../lib/requestContext.js";
import { requirePostRight, requireUnpostRight } from "../lib/postingRights.js";
import { requireItemUnit } from "../lib/requiredItemUnit.js";
import {
  productionOrderDetailHandler,
  productionCostDrilldownHandler,
  productionIssuePreviewHandler,
  productionStatusHandler,
  productionWizardHandler,
  commercialLifecycleRouter,
  productionExecutionRouter,
  productionOverheadClosureRouter,
  getCostSources,
  getBomTemplates,
  getBomTemplate,
  getRoutings,
  getRouting,
  getWorkCenters,
  loadItemUnitOptions,
  resolveProductionItemUnit,
} from "./production.js";

const router = Router();

router.use(extractAuth);
router.use((_req, _res, next) => {
  setContextModuleKey("simple_manufacturing");
  next();
});
router.use(requireModulePermission("simple_manufacturing"));
router.use(moduleAudit("simple_manufacturing"));
// Only the commercial lifecycle sub-router is shared with advanced
// production. Never mount the complete production router here.
router.use(commercialLifecycleRouter);
router.use(productionExecutionRouter);
router.use(productionOverheadClosureRouter);

function companyId(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) {
    res.status(401).json({ error: "غير مصرح" });
    return null;
  }
  return cid;
}

const view = requirePermission("simple_manufacturing", "view");
const create = requirePermission("simple_manufacturing", "create");
const edit = requirePermission("simple_manufacturing", "edit");
const remove = requirePermission("simple_manufacturing", "delete");
const post = requirePermission("simple_manufacturing", "post");
const unpost = requirePermission("simple_manufacturing", "unpost");
const exportReport = requirePermission("simple_manufacturing", "export");

router.get("/", view, (_req, res) => {
  res.json({
    module: "simple_manufacturing",
    title: "Simple Manufacturing",
    endpoints: [
      "/catalog", "/execution-catalog", "/resource-costing-readiness", "/cost-sources", "/bom-templates", "/routings", "/work-centers",
      "/orders", "/templates", "/setup/materials", "/setup/products",
      "/setup/warehouses", "/setup/accounting", "/setup/bom", "/setup/bom/:id",
      "/setup/routing", "/setup/routing/:id", "/templates/:id", "/reports",
      "/orders/:id/stages", "/orders/:id/stages/:stageId/start",
      "/orders/:id/stages/:stageId/complete", "/orders/:id/waste-records",
      "/overhead-closures", "/overhead-closures/:id/reopen",
    ],
  });
});

router.get("/resource-costing-readiness", view, (_req, res) => {
  res.json({
    ready: true,
    version: 1,
    electricitySettlement: "posted_industrial_source_driver_reconciliation",
  });
});

// One call hydrates the simple screen without requiring inventory/advanced
// production permissions. These are the same item and warehouse entities.
router.get("/catalog", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    const branchResult = effectiveBranchCondition(req, warehousesTable.branchId, req.query.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const branch = branchResult.cond;
    const templateBranchResult = effectiveBranchCondition(req, productionWizardTemplatesTable.branchId, req.query.branchId);
    if ("deny" in templateBranchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const templateWhere = templateBranchResult.cond
      ? and(eq(productionWizardTemplatesTable.companyId, cid), eq(productionWizardTemplatesTable.isActive, true), templateBranchResult.cond)
      : and(eq(productionWizardTemplatesTable.companyId, cid), eq(productionWizardTemplatesTable.isActive, true));
    const warehouseWhere = branch
      ? and(eq(warehousesTable.companyId, cid), eq(warehousesTable.isActive, true), branch)
      : and(eq(warehousesTable.companyId, cid), eq(warehousesTable.isActive, true));
    const [items, warehouses, templates, bomTemplates, routings, units, accountingSettings, accounts, wasteAccounts] = await Promise.all([
      db.select({
        id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr,
        nameEn: itemsTable.nameEn, itemNature: itemsTable.itemNature,
        unitId: itemsTable.unitId,
        unitCode: unitsTable.code,
      }).from(itemsTable)
        .leftJoin(unitsTable, and(
          eq(itemsTable.unitId, unitsTable.id),
          eq(unitsTable.companyId, cid),
        ))
        .where(and(eq(itemsTable.companyId, cid), eq(itemsTable.status, "active")))
        .orderBy(asc(itemsTable.nameAr)).limit(5000),
      db.select({
        id: warehousesTable.id, code: warehousesTable.code, nameAr: warehousesTable.nameAr,
        branchId: warehousesTable.branchId, isDefault: warehousesTable.isDefault,
      }).from(warehousesTable).where(warehouseWhere).orderBy(asc(warehousesTable.nameAr)),
      db.select().from(productionWizardTemplatesTable).where(templateWhere)
        .orderBy(desc(productionWizardTemplatesTable.updatedAt)),
      db.select({
        id: bomTemplatesTable.id,
        nameAr: bomTemplatesTable.nameAr,
        productItemId: bomTemplatesTable.productItemId,
        productNameAr: itemsTable.nameAr,
        outputQty: bomTemplatesTable.outputQty,
        outputUnitCode: bomTemplatesTable.outputUnitCode,
        linesCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${bomTemplateLinesTable}
          WHERE ${bomTemplateLinesTable.templateId} = ${bomTemplatesTable.id}
        )`,
      }).from(bomTemplatesTable)
        .leftJoin(itemsTable, and(
          eq(itemsTable.id, bomTemplatesTable.productItemId),
          eq(itemsTable.companyId, cid),
        ))
        .where(and(
          eq(bomTemplatesTable.companyId, cid),
          eq(bomTemplatesTable.isActive, true),
        ))
        .orderBy(desc(bomTemplatesTable.updatedAt)),
      db.select().from(productionRoutingsTable).where(and(
        eq(productionRoutingsTable.companyId, cid),
        eq(productionRoutingsTable.isActive, true),
      )).orderBy(desc(productionRoutingsTable.updatedAt)),
      db.select({
        id: unitsTable.id,
        code: unitsTable.code,
        nameAr: unitsTable.nameAr,
      }).from(unitsTable)
        .where(eq(unitsTable.companyId, cid))
        .orderBy(asc(unitsTable.code)),
      db.select().from(manufacturingSettingsTable)
        .where(eq(manufacturingSettingsTable.companyId, cid))
        .limit(1),
      db.select({
        id: accountsTable.id,
        code: accountsTable.code,
        nameAr: accountsTable.nameAr,
        nameEn: accountsTable.nameEn,
        accountType: accountsTable.accountType,
        isPosting: accountsTable.isPosting,
      }).from(accountsTable)
        .where(and(
          eq(accountsTable.companyId, cid),
          eq(accountsTable.isActive, true),
          eq(accountsTable.isPosting, true),
          eq(accountsTable.accountType, "asset"),
        ))
        .orderBy(asc(accountsTable.code))
        .limit(2000),
      // Waste is posted as a manufacturing expense. Keep the asset and
      // expense lookups separate so the existing account contract remains
      // clear to callers of the compact catalog.
      db.select({
        id: accountsTable.id,
        code: accountsTable.code,
        nameAr: accountsTable.nameAr,
        nameEn: accountsTable.nameEn,
        accountType: accountsTable.accountType,
        isPosting: accountsTable.isPosting,
      }).from(accountsTable)
        .where(and(
          eq(accountsTable.companyId, cid),
          eq(accountsTable.isActive, true),
          eq(accountsTable.isPosting, true),
          eq(accountsTable.accountType, "expense"),
        ))
        .orderBy(asc(accountsTable.code))
        .limit(2000),
    ]);
    const routingIds = routings.map((routing) => routing.id);
    const routingProductIds = [...new Set<number>(
      routings
        .map((routing) => routing.productItemId)
        .filter((id: number | null): id is number => id !== null),
    )];
    const routingStages = routingIds.length
      ? await db.select({
        routingId: productionRoutingStagesTable.routingId,
        id: productionRoutingStagesTable.id,
        nameAr: productionRoutingStagesTable.nameAr,
        sequence: productionRoutingStagesTable.sequence,
        plannedMinutes: productionRoutingStagesTable.expectedDurationMinutes,
        workCenterId: productionRoutingStagesTable.workCenterId,
        resourceMode: productionRoutingStagesTable.resourceMode,
        resourceId: productionRoutingStagesTable.resourceId,
        workerCount: productionRoutingStagesTable.workerCount,
      }).from(productionRoutingStagesTable)
        .where(inArray(productionRoutingStagesTable.routingId, routingIds))
        .orderBy(asc(productionRoutingStagesTable.sequence), asc(productionRoutingStagesTable.id))
      : [];
    const routingProducts = routingProductIds.length
      ? await db.select({
        id: itemsTable.id,
        nameAr: itemsTable.nameAr,
      }).from(itemsTable)
        .where(and(
          eq(itemsTable.companyId, cid),
          inArray(itemsTable.id, routingProductIds),
        ))
      : [];
    const productNameById = new Map(routingProducts.map((item) => [item.id, item.nameAr]));
    const stagesByRouting = new Map<number, Array<{
      id: number;
      nameAr: string;
      sequence: number;
      plannedMinutes: number | null;
      workCenterId: number | null;
      resourceMode: string;
      resourceId: number | null;
      workerCount: number | null;
    }>>();
    for (const stage of routingStages) {
      const stages = stagesByRouting.get(stage.routingId);
      const stageSummary = {
        id: stage.id,
        nameAr: stage.nameAr,
        sequence: stage.sequence,
        plannedMinutes: stage.plannedMinutes,
        workCenterId: stage.workCenterId,
        resourceMode: stage.resourceMode,
        resourceId: stage.resourceId,
        workerCount: stage.workerCount,
      };
      if (stages) stages.push(stageSummary);
      else stagesByRouting.set(stage.routingId, [stageSummary]);
    }
    const routingCatalog = routings.map((routing) => ({
      ...routing,
      productNameAr: routing.productItemId == null
        ? null
        : productNameById.get(routing.productItemId) ?? null,
      stages: stagesByRouting.get(routing.id) ?? [],
    }));
    const itemsWithUnitOptions = await Promise.all(items.map(async (item) => ({
      ...item,
      unitOptions: await loadItemUnitOptions(cid, item.id),
    })));
    res.json({
      items: itemsWithUnitOptions,
      warehouses,
      templates,
      bomTemplates,
      routings: routingCatalog,
      units,
      accounting: {
        settings: accountingSettings[0] ?? null,
        accounts: [...accounts, ...wasteAccounts],
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Execution pickers intentionally live on the compact manufacturing facade.
// They expose only IDs/display names (never HR records, salaries or
// employment fields), and machines remain branch-scoped.
router.get("/execution-catalog", view, async (req, res) => {
  try {
    const cid = companyId(req, res);
    if (!cid) return;
    const branchResult = effectiveBranchCondition(
      req,
      productionResourcesTable.branchId,
      req.query.branchId,
    );
    if ("deny" in branchResult) {
      return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    }
    const machineWhere = branchResult.cond
      ? and(
        eq(productionResourcesTable.companyId, cid),
        eq(productionResourcesTable.type, "machine"),
        branchResult.cond,
      )
      : and(
        eq(productionResourcesTable.companyId, cid),
        eq(productionResourcesTable.type, "machine"),
      );
    const [machines, workers] = await Promise.all([
      db.select({
        id: productionResourcesTable.id,
        name: productionResourcesTable.name,
        type: productionResourcesTable.type,
        branchId: productionResourcesTable.branchId,
        fixedAssetId: productionResourcesTable.fixedAssetId,
        electricityEnabled: productionResourcesTable.electricityEnabled,
        electricityKw: productionResourcesTable.electricityKw,
      }).from(productionResourcesTable).where(machineWhere)
        .orderBy(asc(productionResourcesTable.name)),
      db.select({
        id: usersTable.id,
        nameAr: usersTable.nameAr,
        nameEn: usersTable.nameEn,
        username: usersTable.username,
      }).from(usersTable).where(eq(usersTable.companyId, cid))
        .orderBy(asc(usersTable.nameAr), asc(usersTable.nameEn), asc(usersTable.username)),
    ]);
    res.json({ machines, workers });
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

// Shared read-only source/capacity lookup. This deliberately uses the
// advanced helper rather than mounting the production router, so a simple
// tenant never needs the advanced production company gate. The helper keeps
// the exact sourceType/sourceRecordId/sourceAmount/meta/allocatedAmount/
// availableAmount contract and applies the caller's tenant + branch scope.
router.get("/cost-sources", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const rawBranchId = req.query.branchId;
  const requestedBranchId = rawBranchId == null || rawBranchId === ""
    ? undefined
    : Number(rawBranchId);
  if (requestedBranchId !== undefined &&
      (!Number.isInteger(requestedBranchId) || requestedBranchId <= 0)) {
    return void res.status(400).json({ error: "branchId غير صحيح" });
  }
  try {
    res.json(await getCostSources(db, cid, String(req.query.period ?? ""), req, requestedBranchId));
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

function productItemQuery(req: any, res: any): number | undefined | null {
  const raw = req.query.productItemId;
  if (raw == null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    res.status(400).json({ error: "productItemId غير صحيح" });
    return null;
  }
  return value;
}

// These are the canonical setup envelopes from /production. They are
// read-only and tenant-scoped; no advanced-production permission is involved.
router.get("/bom-templates", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const productItemId = productItemQuery(req, res);
  if (productItemId === null) return;
  try {
    res.json(await getBomTemplates(
      db,
      cid,
      productItemId,
      String(req.query.q ?? "").trim(),
    ));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/bom-templates/:id", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return void res.status(400).json({ error: "id غير صحيح" });
  }
  try {
    const template = await getBomTemplate(db, cid, id);
    if (!template) return void res.status(404).json({ error: "القالب غير موجود" });
    res.json(template);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.get("/routings", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const productItemId = productItemQuery(req, res);
  if (productItemId === null) return;
  try {
    res.json(await getRoutings(
      db,
      cid,
      productItemId,
      String(req.query.q ?? "").trim(),
    ));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/routings/:id", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return void res.status(400).json({ error: "id غير صحيح" });
  }
  try {
    const routing = await getRouting(db, cid, id);
    if (!routing) return void res.status(404).json({ error: "غير موجود" });
    res.json(routing);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.get("/work-centers", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    res.json(await getWorkCenters(
      db,
      cid,
      String(req.query.q ?? "").trim(),
      req.query.activeOnly === "1",
    ));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const materialSetupHandler = async (req: any, res: any) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const code = String(req.body?.code ?? "").trim();
  const nameAr = String(req.body?.nameAr ?? "").trim();
  const allowedNature = new Set(["raw", "semi", "finished", "consumable", "merchandise"]);
  const itemNature = String(req.body?.itemNature || "raw");
  if (!code || !nameAr) return void res.status(400).json({ error: "رمز المادة واسمها مطلوبان" });
  if (!allowedNature.has(itemNature)) return void res.status(400).json({ error: "طبيعة مادة غير صحيحة" });
  try {
    let unitId: number;
    try {
      unitId = requireItemUnit(req.body?.unitId);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    const [unit] = await db.select({ id: unitsTable.id }).from(unitsTable)
      .where(and(eq(unitsTable.id, unitId), eq(unitsTable.companyId, cid)))
      .limit(1);
    if (!unit) return void res.status(400).json({ error: "وحدة الصنف لا تنتمي إلى هذه الشركة" });
    const [duplicate] = await db.select({ id: itemsTable.id }).from(itemsTable)
      .where(and(eq(itemsTable.companyId, cid), eq(itemsTable.code, code))).limit(1);
    if (duplicate) return void res.status(409).json({ error: "رمز المادة مستخدم بالفعل" });
    const [row] = await db.insert(itemsTable).values({
      companyId: cid, code, nameAr,
      nameEn: req.body?.nameEn ? String(req.body.nameEn).trim() : null,
      itemType: "stock", itemNature: itemNature as "raw" | "semi" | "finished" | "consumable" | "merchandise",
      unitId,
      status: "active",
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

router.post("/setup/materials", create, materialSetupHandler);
// Products are the same tenant-scoped inventory entity; keeping a dedicated
// alias makes the compact screen self-contained without granting inventory
// module access.
router.post("/setup/products", create, materialSetupHandler);

router.post("/setup/warehouses", create, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const code = String(req.body?.code ?? "").trim();
  const nameAr = String(req.body?.nameAr ?? "").trim();
  if (!code || !nameAr) return void res.status(400).json({ error: "رمز المخزن واسمه مطلوبان" });
  if (code.length > 80 || nameAr.length > 200) {
    return void res.status(400).json({ error: "بيانات المخزن تتجاوز الحد المسموح" });
  }
  const requestedBranch = req.body?.branchId == null || req.body?.branchId === ""
    ? null : Number(req.body.branchId);
  if (requestedBranch !== null && !Number.isInteger(requestedBranch)) {
    return void res.status(400).json({ error: "الفرع غير صحيح" });
  }
  try {
    const branchId = intersectBranchRequest(req, requestedBranch);
    if (branchId === "deny") return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    if (branchId !== null) {
      const [branch] = await db.select({ id: branchesTable.id }).from(branchesTable)
        .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid))).limit(1);
      if (!branch) return void res.status(400).json({ error: "الفرع غير موجود في هذه الشركة" });
    }
    const [duplicate] = await db.select({ id: warehousesTable.id }).from(warehousesTable)
      .where(and(eq(warehousesTable.companyId, cid), eq(warehousesTable.code, code))).limit(1);
    if (duplicate) return void res.status(409).json({ error: "رمز المخزن مستخدم بالفعل" });
    const [row] = await db.insert(warehousesTable).values({
      companyId: cid,
      branchId,
      code,
      nameAr,
      nameEn: req.body?.nameEn ? String(req.body.nameEn).trim() : null,
      city: req.body?.city ? String(req.body.city).trim() : null,
      isDefault: req.body?.isDefault === true,
      isActive: true,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    const code = String(e?.code ?? "");
    res.status(code === "23505" ? 409 : 500).json({ error: code === "23505" ? "يوجد مخزن افتراضي آخر لهذه الشركة" : e.message });
  }
});

// The compact screen owns only the small set of manufacturing defaults needed
// to post a simple order.  It deliberately reuses the company's existing
// posting accounts instead of creating a second chart of accounts or exposing
// the advanced production settings screen.
router.put("/setup/accounting", edit, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const keys = [
    "defaultWipAccountId",
    "defaultRawInventoryAccountId",
    "defaultFinishedGoodsAccountId",
    "defaultWasteAccountId",
  ] as const;
  const values: Record<(typeof keys)[number], number | null> = {
    defaultWipAccountId: null,
    defaultRawInventoryAccountId: null,
    defaultFinishedGoodsAccountId: null,
    defaultWasteAccountId: null,
  };
  try {
    const [current] = await db.select({
      defaultWipAccountId: manufacturingSettingsTable.defaultWipAccountId,
      defaultRawInventoryAccountId: manufacturingSettingsTable.defaultRawInventoryAccountId,
      defaultFinishedGoodsAccountId: manufacturingSettingsTable.defaultFinishedGoodsAccountId,
      defaultWasteAccountId: manufacturingSettingsTable.defaultWasteAccountId,
      electricityTariffPerKwh: manufacturingSettingsTable.electricityTariffPerKwh,
    }).from(manufacturingSettingsTable)
      .where(eq(manufacturingSettingsTable.companyId, cid)).limit(1);
    const requestedIds = new Set<number>();
    let electricityTariffPerKwh: string | null = current?.electricityTariffPerKwh ?? null;
    if (req.body?.electricityTariffPerKwh !== undefined) {
      if (req.body.electricityTariffPerKwh === null || req.body.electricityTariffPerKwh === "") {
        electricityTariffPerKwh = null;
      } else {
        const tariff = Number(req.body.electricityTariffPerKwh);
        if (!Number.isFinite(tariff) || tariff <= 0) {
          return void res.status(400).json({ error: "تعريفة الكهرباء لكل kWh يجب أن تكون موجبة" });
        }
        electricityTariffPerKwh = String(tariff);
      }
    }
    for (const key of keys) {
      const raw = req.body?.[key];
      if (raw === undefined) {
        values[key] = current?.[key] ?? null;
        if (values[key]) requestedIds.add(values[key]!);
        continue;
      }
      if (raw === null || raw === undefined || raw === "") {
        values[key] = null;
        continue;
      }
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) {
        return void res.status(400).json({ error: `الحساب المحدد للحقل ${key} غير صحيح` });
      }
      values[key] = id;
      requestedIds.add(id);
    }
    if (requestedIds.size) {
      const rows = await db.select({
        id: accountsTable.id,
        accountType: accountsTable.accountType,
        isActive: accountsTable.isActive,
        isPosting: accountsTable.isPosting,
      }).from(accountsTable).where(and(
        eq(accountsTable.companyId, cid),
        inArray(accountsTable.id, Array.from(requestedIds)),
      ));
      const validIds = new Set(rows
        .filter((row) => row.isActive && row.isPosting)
        .map((row) => row.id));
      for (const id of requestedIds) {
        const row = rows.find((candidate) => candidate.id === id);
        const wasteId = values.defaultWasteAccountId;
        const expectedType = wasteId === id ? "expense" : "asset";
        if (!validIds.has(id) || row?.accountType !== expectedType) {
          return void res.status(400).json({
            error: expectedType === "expense"
              ? "اختر حساب هالك مصروفاً نشطاً وقابلاً للترحيل من دليل حسابات الشركة"
              : "اختر حسابات أصول قابلة للترحيل ونشطة من دليل حسابات الشركة",
          });
        }
      }
    }
    const [row] = await db.insert(manufacturingSettingsTable).values({
      companyId: cid,
      ...values,
      electricityTariffPerKwh,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: manufacturingSettingsTable.companyId,
      set: {
        ...values,
        electricityTariffPerKwh,
        updatedAt: new Date(),
      },
    }).returning();
    res.json({ settings: row });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/orders", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    const conditions: any[] = [eq(productionOrdersTable.companyId, cid)];
    const branchResult = effectiveBranchCondition(req, productionOrdersTable.branchId, req.query.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const branch = branchResult.cond;
    if (branch) conditions.push(branch);
    if (typeof req.query.status === "string" && req.query.status) {
      conditions.push(eq(productionOrdersTable.status, req.query.status));
    }
    const rows = await db.select({
      id: productionOrdersTable.id,
      orderNumber: productionOrdersTable.orderNumber,
      title: productionOrdersTable.title,
      status: productionOrdersTable.status,
      plannedQty: productionOrdersTable.plannedQty,
      producedQty: productionOrdersTable.producedQty,
      wasteQty: productionOrdersTable.wasteQty,
      estimatedCost: productionOrdersTable.estimatedCost,
      actualCost: productionOrdersTable.actualCost,
      resourceCostingVersion: productionOrdersTable.resourceCostingVersion,
      productItemId: productionOrdersTable.productItemId,
      plannedStartDate: productionOrdersTable.plannedStartDate,
      plannedEndDate: productionOrdersTable.plannedEndDate,
      branchId: productionOrdersTable.branchId,
      createdAt: productionOrdersTable.createdAt,
    }).from(productionOrdersTable).where(and(...conditions))
      .orderBy(desc(productionOrdersTable.createdAt)).limit(500);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// The existing wizard is configuration-only until the status route posts
// stock/GL. Keeping the request under this facade avoids exposing /production.
const compactWizardHandler = async (req: any, res: any) => {
  req.url = "/orders/wizard";
  return productionWizardHandler(req, res);
};

router.post("/orders", create, compactWizardHandler);
router.post("/orders/wizard", create, compactWizardHandler);

router.delete("/orders/:id", remove, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  try {
    const [order] = await db.select({
      id: productionOrdersTable.id,
      status: productionOrdersTable.status,
      branchId: productionOrdersTable.branchId,
    }).from(productionOrdersTable).where(and(
      eq(productionOrdersTable.id, id), eq(productionOrdersTable.companyId, cid),
    )).limit(1);
    if (!order) return void res.status(404).json({ error: "أمر الإنتاج غير موجود" });
    const branchResult = effectiveBranchCondition(req, productionOrdersTable.branchId, order.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    if (order.status !== "draft") {
      return void res.status(409).json({ error: "لا يمكن حذف أمر غير مسودة؛ استخدم الإلغاء أو العكس حسب حالته" });
    }
    const [allocation] = await db.select({ id: productionCostAllocationsTable.id })
      .from(productionCostAllocationsTable)
      .where(eq(productionCostAllocationsTable.orderId, id)).limit(1);
    if (allocation) return void res.status(409).json({ error: "لا يمكن حذف أمر يحتوي على روابط مصادر تكلفة" });
    await db.delete(productionOrdersTable).where(and(
      eq(productionOrdersTable.id, id), eq(productionOrdersTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function simpleStatusAction(req: any): "post" | "unpost" {
  return /^(cancelled|reversed)$/i.test(String(req.body?.status ?? "")) ? "unpost" : "post";
}

function simpleStatusPermission(req: any, res: any, next: any) {
  const action = simpleStatusAction(req);
  return (action === "unpost" ? unpost : post)(req, res, next);
}

function simpleStatusPostingRight(req: any, res: any, next: any) {
  const action = simpleStatusAction(req);
  return (action === "unpost" ? requireUnpostRight("simple_manufacturing") : requirePostRight("simple_manufacturing"))(req, res, next);
}

router.post("/orders/:id/status", simpleStatusPermission, simpleStatusPostingRight, async (req, res) => {
  // A draft can be saved before accounting is configured.  Once the user
  // fixes the compact setup, hydrate only still-empty pre-issue fields on the
  // existing order before retrying the same status transition.  This keeps the
  // wizard's idempotent order id while preserving the frozen values once stock
  // has been issued.
  const target = String(req.body?.status ?? "");
  if (target === "approved" || target === "in_production" ||
      target === "quality_check" || target === "completed") {
    const cid = companyId(req, res);
    if (!cid) return;
    const id = Number(req.params.id);
    const [order] = await db.select({
      id: productionOrdersTable.id,
      status: productionOrdersTable.status,
      branchId: productionOrdersTable.branchId,
      wipAccountId: productionOrdersTable.wipAccountId,
      rawInventoryAccountId: productionOrdersTable.rawInventoryAccountId,
      finishedGoodsAccountId: productionOrdersTable.finishedGoodsAccountId,
      wasteAccountId: productionOrdersTable.wasteAccountId,
    }).from(productionOrdersTable).where(and(
      eq(productionOrdersTable.id, id),
      eq(productionOrdersTable.companyId, cid),
    )).limit(1);
    if (order) {
      const branchResult = effectiveBranchCondition(req, productionOrdersTable.branchId, order.branchId);
      if ("deny" in branchResult) {
        return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
      }
      if (order.status === "draft" || order.status === "approved" ||
          order.status === "in_production" || order.status === "quality_check") {
        const [settings] = await db.select({
          wipAccountId: manufacturingSettingsTable.defaultWipAccountId,
          rawInventoryAccountId: manufacturingSettingsTable.defaultRawInventoryAccountId,
          finishedGoodsAccountId: manufacturingSettingsTable.defaultFinishedGoodsAccountId,
          wasteAccountId: manufacturingSettingsTable.defaultWasteAccountId,
        }).from(manufacturingSettingsTable)
          .where(eq(manufacturingSettingsTable.companyId, cid)).limit(1);
        const updates: Record<string, unknown> = {};
        // Keep the read-before-update only for scope/default lookup. The
        // UPDATE itself must win races with issue/approval transitions:
        // status is guarded and each field is filled with SQL COALESCE so a
        // concurrently supplied account can never be overwritten.
        if (settings?.wipAccountId) {
          updates.wipAccountId = sql`coalesce(${productionOrdersTable.wipAccountId}, ${settings.wipAccountId})`;
        }
        if (settings?.rawInventoryAccountId) {
          updates.rawInventoryAccountId = sql`coalesce(${productionOrdersTable.rawInventoryAccountId}, ${settings.rawInventoryAccountId})`;
        }
        if (settings?.finishedGoodsAccountId) {
          updates.finishedGoodsAccountId = sql`coalesce(${productionOrdersTable.finishedGoodsAccountId}, ${settings.finishedGoodsAccountId})`;
        }
        if (settings?.wasteAccountId) {
          updates.wasteAccountId = sql`coalesce(${productionOrdersTable.wasteAccountId}, ${settings.wasteAccountId})`;
        }
        if (Object.keys(updates).length) {
          const updateConditions: any[] = [
            eq(productionOrdersTable.id, id),
            eq(productionOrdersTable.companyId, cid),
            inArray(productionOrdersTable.status, ["draft", "approved", "in_production", "quality_check"]),
          ];
          if (branchResult.cond) updateConditions.push(branchResult.cond);
          await db.update(productionOrdersTable).set({
            ...updates,
            updatedAt: new Date(),
          }).where(and(...updateConditions));
        }
      }
    }
  }
  // This handler performs the atomic stock + GL transition, including pause,
  // resume, cancellation and provenance-checked completed reversal.
  return productionStatusHandler(req, res);
});

for (const [operation, status] of [
  ["pause", "paused"],
  ["resume", "in_production"],
  ["cancel", "cancelled"],
  ["reverse", "reversed"],
] as const) {
  const operationPermission = operation === "cancel" || operation === "reverse" ? unpost : post;
  const operationPostingRight = operation === "cancel" || operation === "reverse"
    ? requireUnpostRight("simple_manufacturing")
    : requirePostRight("simple_manufacturing");
  router.post(`/orders/:id/${operation}`, operationPermission, operationPostingRight, async (req, res) => {
    req.body = { ...(req.body ?? {}), status };
    return productionStatusHandler(req, res);
  });
}

router.get("/templates", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    const branchResult = effectiveBranchCondition(req, productionWizardTemplatesTable.branchId, req.query.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const branch = branchResult.cond;
    const where = branch
      ? and(eq(productionWizardTemplatesTable.companyId, cid), eq(productionWizardTemplatesTable.isActive, true), branch)
      : and(eq(productionWizardTemplatesTable.companyId, cid), eq(productionWizardTemplatesTable.isActive, true));
    res.json(await db.select().from(productionWizardTemplatesTable).where(where)
      .orderBy(desc(productionWizardTemplatesTable.updatedAt)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/templates", create, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const name = String(req.body?.name ?? "").trim();
  if (!name) return void res.status(400).json({ error: "اسم القالب مطلوب" });
  try {
    const bid = intersectBranchRequest(req, req.body?.branchId ?? null);
    if (bid === "deny") return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const configuration = await normalizeSimpleTemplateConfiguration(cid, req.body?.configuration);
    // Configuration-only invariant: no document number, actuals, journals,
    // stock movements, or source allocation data can be stored here.
    const [row] = await db.insert(productionWizardTemplatesTable).values({
      companyId: cid,
      branchId: typeof bid === "number" ? bid : null,
      name: name.slice(0, 250),
      configuration,
      createdBy: req.authUser!.id,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.patch("/templates/:id", edit, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return void res.status(400).json({ error: "id غير صحيح" });
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) return void res.status(400).json({ error: "اسم القالب مطلوب" });
  try {
    const [existing] = await db.select({
      id: productionWizardTemplatesTable.id,
      branchId: productionWizardTemplatesTable.branchId,
      configuration: productionWizardTemplatesTable.configuration,
    }).from(productionWizardTemplatesTable).where(and(
      eq(productionWizardTemplatesTable.id, id),
      eq(productionWizardTemplatesTable.companyId, cid),
      eq(productionWizardTemplatesTable.isActive, true),
    )).limit(1);
    if (!existing) return void res.status(404).json({ error: "القالب غير موجود" });

    // A template is company-wide or branch-scoped, but never editable through
    // a branch the caller cannot access. The company predicate above prevents
    // cross-tenant updates even when a valid id is supplied.
    const branchResult = effectiveBranchCondition(
      req,
      productionWizardTemplatesTable.branchId,
      existing.branchId,
    );
    if ("deny" in branchResult) {
      return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    }
    const configuration = {
      ...(existing.configuration ?? {}),
      ...(await normalizeSimpleTemplateConfiguration(cid, req.body?.configuration)),
    };
    const [row] = await db.update(productionWizardTemplatesTable).set({
      name: name.slice(0, 250),
      configuration,
      updatedAt: new Date(),
    }).where(and(
      eq(productionWizardTemplatesTable.id, id),
      eq(productionWizardTemplatesTable.companyId, cid),
      eq(productionWizardTemplatesTable.isActive, true),
    )).returning();
    if (!row) return void res.status(404).json({ error: "القالب غير موجود" });
    res.json(row);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.delete("/templates/:id", remove, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  try {
    const [existing] = await db.select({ branchId: productionWizardTemplatesTable.branchId })
      .from(productionWizardTemplatesTable).where(and(
        eq(productionWizardTemplatesTable.id, id), eq(productionWizardTemplatesTable.companyId, cid),
      )).limit(1);
    if (!existing) return void res.status(404).json({ error: "القالب غير موجود" });
    const branchResult = effectiveBranchCondition(req, productionWizardTemplatesTable.branchId, existing.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const [row] = await db.update(productionWizardTemplatesTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(productionWizardTemplatesTable.id, id), eq(productionWizardTemplatesTable.companyId, cid)))
      .returning({ id: productionWizardTemplatesTable.id });
    if (!row) return void res.status(404).json({ error: "القالب غير موجود" });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function setupError(message: string, status = 400): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

/**
 * Quick-order templates only store reusable configuration. Normalize the
 * fields owned by the compact screen at the API boundary and verify the
 * product/unit against the current tenant before either creating or editing a
 * row. Other configuration keys are retained for compatibility with templates
 * created by the visual setup flow.
 */
async function normalizeSimpleTemplateConfiguration(cid: number, value: unknown) {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!raw) throw setupError("إعدادات القالب مطلوبة");

  const productItemId = Number(raw.productItemId);
  if (!Number.isInteger(productItemId) || productItemId <= 0) {
    throw setupError("منتج القالب مطلوب");
  }
  const plannedQty = Number(raw.plannedQty ?? 1);
  if (!Number.isFinite(plannedQty) || plannedQty <= 0) {
    throw setupError("كمية القالب يجب أن تكون أكبر من صفر");
  }

  const [product] = await db.select({
    id: itemsTable.id,
    unitCode: unitsTable.code,
  }).from(itemsTable).leftJoin(unitsTable, and(
    eq(itemsTable.unitId, unitsTable.id),
    eq(unitsTable.companyId, cid),
  )).where(and(
    eq(itemsTable.id, productItemId),
    eq(itemsTable.companyId, cid),
    eq(itemsTable.status, "active"),
  )).limit(1);
  if (!product) throw setupError("منتج القالب غير موجود أو غير نشط في هذه الشركة");

  const requestedUnitCode = typeof raw.unitCode === "string" ? raw.unitCode.trim() : "";
  const unitCode = requestedUnitCode || product.unitCode || "PCE";
  let canonicalUnitCode: string;
  try {
    canonicalUnitCode = (await resolveProductionItemUnit(cid, productItemId, unitCode)).unitCode;
  } catch (e: any) {
    throw setupError(
      e?.message ?? `وحدة القياس "${unitCode}" غير مرتبطة بالمنتج`,
      e?.status ?? 400,
    );
  }

  return {
    ...raw,
    productItemId,
    plannedQty,
    unitCode: canonicalUnitCode,
  };
}

/**
 * BOMs and routings are company-wide core manufacturing definitions (their
 * tables intentionally do not have a branch column).  A caller may still
 * send a branch selection from the compact screen; validate that selection
 * before touching a global definition so a restricted user cannot use the
 * setup endpoint as a branch-scope bypass.
 */
async function validateSetupBranch(req: any, cid: number, rawBranch: unknown) {
  const requestedBranch = rawBranch == null || rawBranch === "" ? null : Number(rawBranch);
  if (requestedBranch !== null &&
      (!Number.isInteger(requestedBranch) || requestedBranch <= 0)) {
    throw setupError("الفرع غير صحيح");
  }
  const branchId = intersectBranchRequest(req, requestedBranch);
  if (branchId === "deny") {
    throw setupError("لا يمكنك العمل على هذا الفرع", 403);
  }
  if (typeof branchId === "number") {
    const [branch] = await db.select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)))
      .limit(1);
    if (!branch) throw setupError("الفرع غير موجود في هذه الشركة");
  }
  return branchId;
}

/**
 * Normalize a compact BOM payload once at the facade boundary.  This keeps
 * edit validation identical to create validation: every item and unit must
 * belong to the acting company and the stored output/unit metadata is always
 * canonical.
 */
async function normalizeSetupBom(cid: number, body: any) {
  const productItemId = Number(body?.productItemId);
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (!Number.isInteger(productItemId) || !lines.length) {
    throw setupError("المنتج النهائي وسطور المواد مطلوبان");
  }
  const [product] = await db.select({
    id: itemsTable.id,
    unitCode: unitsTable.code,
  }).from(itemsTable)
    .leftJoin(unitsTable, and(
      eq(itemsTable.unitId, unitsTable.id),
      eq(unitsTable.companyId, cid),
    ))
    .where(and(
      eq(itemsTable.id, productItemId),
      eq(itemsTable.companyId, cid),
      eq(itemsTable.status, "active"),
    )).limit(1);
  if (!product) throw setupError("المنتج النهائي غير موجود");

  const normalizedLines = lines.map((x: any) => ({
    itemId: Number(x?.itemId ?? x?.item?.id),
    quantity: Number(x?.quantity),
    description: String(x?.description || "مادة خام").trim(),
    unitCode: x?.unitCode == null ? "" : String(x.unitCode).trim(),
    notes: x?.notes ? String(x.notes) : null,
  }));
  if (normalizedLines.some((x: any) =>
    !Number.isInteger(x.itemId) || x.itemId <= 0 ||
    !Number.isFinite(x.quantity) || x.quantity <= 0 ||
    !x.description
  )) {
    throw setupError("كل سطر في قائمة المواد يحتاج صنفاً وكمية أكبر من صفر");
  }

  const uniqueItemIds: number[] = [...new Set<number>(
    normalizedLines.map((x: any) => x.itemId),
  )];
  const owned = await db.select({
    id: itemsTable.id,
    unitCode: unitsTable.code,
  }).from(itemsTable)
    .leftJoin(unitsTable, and(
      eq(itemsTable.unitId, unitsTable.id),
      eq(unitsTable.companyId, cid),
    ))
    .where(and(
      eq(itemsTable.companyId, cid),
      eq(itemsTable.status, "active"),
      inArray(itemsTable.id, uniqueItemIds),
    ));
  if (owned.length !== uniqueItemIds.length) {
    throw setupError("إحدى المواد غير موجودة أو غير نشطة في هذه الشركة");
  }

  const ownedByItem = new Map(owned.map((item) => [item.id, item]));
  for (const line of normalizedLines) {
    const item = ownedByItem.get(line.itemId);
    const requestedCode = line.unitCode || item?.unitCode || "PCE";
    try {
      const resolved = await resolveProductionItemUnit(cid, line.itemId, requestedCode);
      line.unitCode = resolved.unitCode;
    } catch (e: any) {
      throw setupError(
        e?.message ?? `وحدة القياس "${requestedCode}" غير مرتبطة بالصنف`,
        e?.status ?? 400,
      );
    }
  }

  const requestedOutputCode = body?.outputUnitCode == null
    ? "" : String(body.outputUnitCode).trim();
  const outputCode = requestedOutputCode || product.unitCode || "PCE";
  let actualOutputCode: string;
  try {
    actualOutputCode = (await resolveProductionItemUnit(cid, productItemId, outputCode)).unitCode;
  } catch (e: any) {
    throw setupError(
      e?.message ?? `وحدة الناتج "${outputCode}" غير مرتبطة بالمنتج`,
      e?.status ?? 400,
    );
  }
  const outputQty = Number(body?.outputQty ?? 1);
  if (!Number.isFinite(outputQty) || outputQty <= 0) {
    throw setupError("كمية الناتج يجب أن تكون أكبر من صفر");
  }
  return {
    productItemId,
    normalizedLines,
    nameAr: String(body?.nameAr || "قائمة مواد مبسطة").trim(),
    outputQty,
    actualOutputCode,
    nameEn: body?.nameEn ? String(body.nameEn).trim() : null,
    notes: body?.notes ? String(body.notes) : null,
  };
}

async function normalizeSetupRouting(cid: number, body: any) {
  // Resource costing is separately versioned and currently server-gated. Do
  // not make a legacy routing (including the historic compact `stage` string)
  // invalid merely because it has no resource configuration.
  const resourceCostingV1 = Number(body?.resourceCostingVersion) === 1;
  const productItemId = Number(body?.productItemId);
  const stages = Array.isArray(body?.stages)
    ? body.stages
    : typeof body?.stages === "string"
      ? [body.stages]
      : body?.stage != null
        ? [body.stage]
        : [];
  if (!Number.isInteger(productItemId) || !stages.length) {
    throw setupError("المنتج ومراحل المسار مطلوبان");
  }
  const [product] = await db.select({ id: itemsTable.id }).from(itemsTable)
    .where(and(
      eq(itemsTable.id, productItemId),
      eq(itemsTable.companyId, cid),
      eq(itemsTable.status, "active"),
    )).limit(1);
  if (!product) throw setupError("المنتج النهائي غير موجود");

  const normalizedStages = stages.map((rawStage: any, i: number) => {
    const x = typeof rawStage === "string" ? { nameAr: rawStage } : (rawStage ?? {});
    const rawDuration = x.expectedDurationMinutes == null || x.expectedDurationMinutes === ""
      ? x.plannedMinutes
      : x.expectedDurationMinutes;
    const rawWorkCenterId = x.workCenterId == null || x.workCenterId === ""
      ? null : Number(x.workCenterId);
    const rawAccountId = x.expectedCostAccountId == null || x.expectedCostAccountId === ""
      ? null : Number(x.expectedCostAccountId);
    const requestedResourceMode = x.resourceMode == null || x.resourceMode === ""
      ? "labor" : String(x.resourceMode);
    const resourceMode = !resourceCostingV1 &&
      !["labor", "machine", "both"].includes(requestedResourceMode)
      ? "labor"
      : requestedResourceMode;
    const resourceId = x.resourceId == null || x.resourceId === ""
      ? null : Number(x.resourceId);
    const workerCount = x.workerCount == null || x.workerCount === ""
      ? null : Number(x.workerCount);
    return {
      code: String(x.code || `S${i + 1}`).trim(),
      nameAr: String(x.nameAr || `مرحلة ${i + 1}`).trim(),
      nameEn: x.nameEn ? String(x.nameEn).trim() : null,
      expectedDurationMinutes: rawDuration == null || rawDuration === ""
        ? null : Number(rawDuration),
      expectedWasteRatio: x.expectedWasteRatio == null || x.expectedWasteRatio === ""
        ? 0 : Number(x.expectedWasteRatio),
      expectedCost: x.expectedCost == null || x.expectedCost === "" ? 0 : Number(x.expectedCost),
      expectedCostAccountId: rawAccountId,
      workCenterId: rawWorkCenterId,
      resourceMode,
      resourceId,
      workerCount,
      notes: x.notes ? String(x.notes) : null,
      icon: x.icon ? String(x.icon) : null,
      color: x.color ? String(x.color) : null,
    };
  });
  if (normalizedStages.some((x: any) =>
    !x.code || !x.nameAr ||
    (x.expectedDurationMinutes !== null &&
      (!Number.isFinite(x.expectedDurationMinutes) || x.expectedDurationMinutes <= 0)) ||
    (x.workCenterId !== null &&
      (!Number.isInteger(x.workCenterId) || x.workCenterId <= 0)) ||
    (resourceCostingV1 && !["labor", "machine", "both"].includes(x.resourceMode)) ||
    (resourceCostingV1 && (x.resourceMode === "machine" || x.resourceMode === "both") &&
      (x.resourceId === null || !Number.isInteger(x.resourceId) || x.resourceId <= 0)) ||
    (x.workerCount !== null &&
      (!Number.isInteger(x.workerCount) || x.workerCount <= 0)) ||
    (x.expectedCostAccountId !== null &&
      (!Number.isInteger(x.expectedCostAccountId) || x.expectedCostAccountId <= 0)) ||
    !Number.isFinite(x.expectedWasteRatio) || x.expectedWasteRatio < 0 ||
    !Number.isFinite(x.expectedCost) || x.expectedCost < 0
  )) {
    throw setupError("كل مرحلة تحتاج رمزاً واسماً وقيم تكلفة/هالك صحيحة");
  }
  const workCenterIds: number[] = [...new Set<number>(
    normalizedStages
      .map((stage: any) => stage.workCenterId)
      .filter((id: number | null): id is number => id !== null),
  )];
  if (workCenterIds.length) {
    const permittedWorkCenters = await db.select({ id: workCentersTable.id })
      .from(workCentersTable)
      .where(and(
        eq(workCentersTable.companyId, cid),
        inArray(workCentersTable.id, workCenterIds),
      ));
    if (permittedWorkCenters.length !== workCenterIds.length) {
      throw setupError("أحد مراكز العمل غير موجود في هذه الشركة");
    }
  }
  const resourceIds: number[] = [...new Set<number>(
    normalizedStages
      .map((stage: any) => stage.resourceId)
      .filter((id: number | null): id is number => id !== null),
  )];
  if (resourceIds.length) {
    const permittedResources = await db.select({ id: productionResourcesTable.id })
      .from(productionResourcesTable)
      .where(and(
        eq(productionResourcesTable.companyId, cid),
        inArray(productionResourcesTable.id, resourceIds),
        eq(productionResourcesTable.type, "machine"),
      ));
    if (permittedResources.length !== resourceIds.length) {
      throw setupError("إحدى آلات المرحلة غير موجودة في هذه الشركة");
    }
  }
  const accountIds: number[] = [...new Set<number>(
    normalizedStages
      .map((stage: any) => stage.expectedCostAccountId)
      .filter((id: number | null): id is number => id !== null),
  )];
  if (accountIds.length) {
    const permittedAccounts = await db.select({ id: accountsTable.id })
      .from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, accountIds)));
    if (permittedAccounts.length !== accountIds.length) {
      throw setupError("أحد حسابات تكلفة المراحل غير موجود في هذه الشركة");
    }
  }
  return {
    productItemId,
    normalizedStages,
    nameAr: String(body?.nameAr || "مسار مبسط").trim(),
    nameEn: body?.nameEn ? String(body.nameEn).trim() : null,
    notes: body?.notes ? String(body.notes) : null,
  };
}

// BOM/material setup is intentionally inside this facade. It writes the
// existing BOM tables and validates every item against the current tenant.
router.post("/setup/bom", edit, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    await validateSetupBranch(req, cid, req.body?.branchId);
    const normalized = await normalizeSetupBom(cid, req.body);
    const bom = await db.transaction(async (tx) => {
      const [row] = await tx.insert(bomTemplatesTable).values({
        companyId: cid, productItemId: normalized.productItemId, nameAr: normalized.nameAr,
        nameEn: normalized.nameEn,
        outputQty: String(normalized.outputQty),
        outputUnitCode: normalized.actualOutputCode,
        isActive: true,
        notes: normalized.notes,
      }).returning();
      await tx.insert(bomTemplateLinesTable).values(normalized.normalizedLines.map((x: any) => ({
        templateId: row.id, itemId: x.itemId,
        description: x.description,
        quantity: String(x.quantity),
        unitCode: x.unitCode,
        notes: x.notes,
      })));
      return row;
    });
    res.status(201).json(bom);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

// Edit the existing BOM in place. The header id is stable and its lines are
// replaced in one transaction, so saving an edit can never create a second
// active version or leave a partially updated recipe.
router.patch("/setup/bom/:id", edit, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return void res.status(400).json({ error: "id غير صحيح" });
  }
  try {
    await validateSetupBranch(req, cid, req.body?.branchId);
    const [existing] = await db.select({ id: bomTemplatesTable.id })
      .from(bomTemplatesTable)
      .where(and(
        eq(bomTemplatesTable.id, id),
        eq(bomTemplatesTable.companyId, cid),
      )).limit(1);
    if (!existing) return void res.status(404).json({ error: "القائمة غير موجودة" });

    const normalized = await normalizeSetupBom(cid, req.body);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(bomTemplatesTable)
        .set({
          productItemId: normalized.productItemId,
          nameAr: normalized.nameAr,
          nameEn: normalized.nameEn,
          outputQty: String(normalized.outputQty),
          outputUnitCode: normalized.actualOutputCode,
          notes: normalized.notes,
          updatedAt: new Date(),
        })
        .where(and(
          eq(bomTemplatesTable.id, id),
          eq(bomTemplatesTable.companyId, cid),
        ))
        .returning();
      if (!updated) throw setupError("القائمة غير موجودة", 404);
      await tx.delete(bomTemplateLinesTable)
        .where(eq(bomTemplateLinesTable.templateId, id));
      await tx.insert(bomTemplateLinesTable).values(normalized.normalizedLines.map((x: any) => ({
        templateId: id,
        itemId: x.itemId,
        description: x.description,
        quantity: String(x.quantity),
        unitCode: x.unitCode,
        notes: x.notes,
      })));
      return updated;
    });
    res.json(row);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

router.post("/setup/routing", edit, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const productItemId = Number(req.body?.productItemId);
  // The structured stages[] contract is canonical. Accept the compact
  // legacy `stage` string (and string entries in stages[]) so older simple
  // screens keep creating the same one-stage routing.
  const stages = Array.isArray(req.body?.stages)
    ? req.body.stages
    : typeof req.body?.stages === "string"
      ? [req.body.stages]
      : req.body?.stage != null
        ? [req.body.stage]
        : [];
  if (!Number.isInteger(productItemId) || !stages.length) {
    return void res.status(400).json({ error: "المنتج ومراحل المسار مطلوبان" });
  }
  try {
    await validateSetupBranch(req, cid, req.body?.branchId);
    const normalizedResourceStages = (await normalizeSetupRouting(cid, req.body)).normalizedStages;
    const [product] = await db.select({ id: itemsTable.id }).from(itemsTable)
      .where(and(
        eq(itemsTable.id, productItemId),
        eq(itemsTable.companyId, cid),
        eq(itemsTable.status, "active"),
      )).limit(1);
    if (!product) return void res.status(400).json({ error: "المنتج النهائي غير موجود" });
    const normalizedStages = normalizedResourceStages;
    if (normalizedStages.some((x: any) =>
      !x.code || !x.nameAr ||
      (x.expectedDurationMinutes !== null &&
        (!Number.isFinite(x.expectedDurationMinutes) || x.expectedDurationMinutes <= 0)) ||
      (x.workCenterId !== null &&
        (!Number.isInteger(x.workCenterId) || x.workCenterId <= 0)) ||
      !Number.isFinite(x.expectedWasteRatio) || x.expectedWasteRatio < 0 ||
      !Number.isFinite(x.expectedCost) || x.expectedCost < 0
    )) {
      return void res.status(400).json({ error: "كل مرحلة تحتاج رمزاً واسماً وقيم تكلفة/هالك صحيحة" });
    }
    const workCenterIds: number[] = [...new Set<number>(
      normalizedStages
        .map((stage: any) => stage.workCenterId)
        .filter((id: number | null): id is number => id !== null),
    )];
    if (workCenterIds.length) {
      const permittedWorkCenters = await db.select({ id: workCentersTable.id })
        .from(workCentersTable)
        .where(and(
          eq(workCentersTable.companyId, cid),
          inArray(workCentersTable.id, workCenterIds),
        ));
      if (permittedWorkCenters.length !== workCenterIds.length) {
        return void res.status(400).json({ error: "أحد مراكز العمل غير موجود في هذه الشركة" });
      }
    }
    const [routing] = await db.insert(productionRoutingsTable).values({
      companyId: cid, productItemId,
      nameAr: String(req.body?.nameAr || "مسار مبسط"),
      nameEn: req.body?.nameEn ? String(req.body.nameEn) : null,
      notes: req.body?.notes ? String(req.body.notes) : null,
    }).returning();
    await db.insert(productionRoutingStagesTable).values(normalizedStages.map((x: any, i: number) => ({
      routingId: routing.id, sequence: i + 1,
      code: x.code,
      nameAr: x.nameAr,
      nameEn: x.nameEn,
      workCenterId: x.workCenterId,
        resourceMode: x.resourceMode,
        resourceId: x.resourceId,
        workerCount: x.workerCount,
      expectedDurationMinutes: x.expectedDurationMinutes,
      expectedWasteRatio: String(x.expectedWasteRatio),
      expectedCost: String(x.expectedCost),
      notes: x.notes ? String(x.notes) : null,
    })));
    res.status(201).json(routing);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

// Edit an existing routing in place. Header and ordered stages share one
// transaction; stage sequence is derived from array order rather than trusted
// client sequence values.
router.patch("/setup/routing/:id", edit, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return void res.status(400).json({ error: "id غير صحيح" });
  }
  try {
    await validateSetupBranch(req, cid, req.body?.branchId);
    const [existing] = await db.select({ id: productionRoutingsTable.id })
      .from(productionRoutingsTable)
      .where(and(
        eq(productionRoutingsTable.id, id),
        eq(productionRoutingsTable.companyId, cid),
      )).limit(1);
    if (!existing) return void res.status(404).json({ error: "مسار الإنتاج غير موجود" });

    const normalized = await normalizeSetupRouting(cid, req.body);
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(productionRoutingsTable)
        .set({
          productItemId: normalized.productItemId,
          nameAr: normalized.nameAr,
          nameEn: normalized.nameEn,
          notes: normalized.notes,
          updatedAt: new Date(),
        })
        .where(and(
          eq(productionRoutingsTable.id, id),
          eq(productionRoutingsTable.companyId, cid),
        ))
        .returning();
      if (!updated) throw setupError("مسار الإنتاج غير موجود", 404);
      await tx.delete(productionRoutingStagesTable)
        .where(eq(productionRoutingStagesTable.routingId, id));
      await tx.insert(productionRoutingStagesTable).values(normalized.normalizedStages.map((x: any, i: number) => ({
        routingId: id,
        sequence: i + 1,
        code: x.code,
        nameAr: x.nameAr,
        nameEn: x.nameEn,
        workCenterId: x.workCenterId,
        resourceMode: x.resourceMode,
        resourceId: x.resourceId,
        workerCount: x.workerCount,
        expectedDurationMinutes: x.expectedDurationMinutes,
        expectedWasteRatio: String(x.expectedWasteRatio),
        expectedCost: String(x.expectedCost),
        expectedCostAccountId: x.expectedCostAccountId,
        notes: x.notes,
        icon: x.icon,
        color: x.color,
      })));
      return updated;
    });
    res.json(row);
  } catch (e: any) {
    res.status(e?.status ?? 500).json({ error: e.message });
  }
});

const sourceCostHandler = async (req: any, res: any) => {
  const cid = companyId(req, res);
  if (!cid) return;
  const orderId = Number(req.params.id);
  try {
    const [order] = await db.select({ branchId: productionOrdersTable.branchId })
      .from(productionOrdersTable).where(and(
        eq(productionOrdersTable.id, orderId), eq(productionOrdersTable.companyId, cid),
      )).limit(1);
    if (!order) return void res.status(404).json({ error: "أمر الإنتاج غير موجود" });
    const branchResult = effectiveBranchCondition(req, productionOrdersTable.branchId, order.branchId);
    if ("deny" in branchResult) return void res.status(404).json({ error: "أمر الإنتاج غير موجود" });
    const rows = await db.select().from(productionCostAllocationsTable)
      .where(and(eq(productionCostAllocationsTable.companyId, cid), eq(productionCostAllocationsTable.orderId, orderId)))
      .orderBy(asc(productionCostAllocationsTable.id));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

router.get("/orders/:id/source-costs", view, sourceCostHandler);
router.get("/orders/:id/costs", view, sourceCostHandler);
// The detail page is shared with advanced production and expects the canonical
// drilldown envelope (`totals`, `trace.labor`, `trace.overhead`, etc.). Reuse
// the guarded handler instead of returning a compact placeholder shape that
// makes the shared page dereference missing financial fields.
router.get("/orders/:id/cost-drilldown", view, productionCostDrilldownHandler);
// This is a read-only preview. It uses the same warehouse balance/batch
// calculation as issue time, but never creates stock or ledger rows.
router.get("/orders/:id/issue-preview", view, productionIssuePreviewHandler);

router.get("/suppliers", view, async (req, res) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    const branchResult = effectiveBranchCondition(req, suppliersTable.branchId, req.query.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const conditions: any[] = [eq(suppliersTable.companyId, cid), eq(suppliersTable.isActive, true)];
    if (branchResult.cond) conditions.push(branchResult.cond);
    const rows = await db.select({
      id: suppliersTable.id,
      nameAr: suppliersTable.nameAr,
      nameEn: suppliersTable.nameEn,
      branchId: suppliersTable.branchId,
      accountId: suppliersTable.accountId,
    }).from(suppliersTable).where(and(...conditions)).orderBy(asc(suppliersTable.nameAr));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Reuse the canonical detail endpoint implementation, but only after the
// compact module gate and compact user view permission have passed. This must
// stay after the source-costs literal route.
router.get("/orders/:id", view, productionOrderDetailHandler);

const simpleReportHandler = async (req: any, res: any) => {
  const cid = companyId(req, res);
  if (!cid) return;
  try {
    const branchResult = effectiveBranchCondition(req, productionOrdersTable.branchId, req.query.branchId);
    if ("deny" in branchResult) return void res.status(403).json({ error: "لا يمكنك العمل على هذا الفرع" });
    const conditions: any[] = [eq(productionOrdersTable.companyId, cid)];
    if (branchResult.cond) conditions.push(branchResult.cond);
    const rows = await db.select({
      id: productionOrdersTable.id,
      orderNumber: productionOrdersTable.orderNumber,
      title: productionOrdersTable.title,
      status: productionOrdersTable.status,
      plannedQty: productionOrdersTable.plannedQty,
      producedQty: productionOrdersTable.producedQty,
      estimatedCost: productionOrdersTable.estimatedCost,
      actualCost: productionOrdersTable.actualCost,
      resourceCostingVersion: productionOrdersTable.resourceCostingVersion,
      productItemId: productionOrdersTable.productItemId,
      productName: itemsTable.nameAr,
      createdAt: productionOrdersTable.createdAt,
    }).from(productionOrdersTable)
      .leftJoin(itemsTable, and(
        eq(itemsTable.id, productionOrdersTable.productItemId),
        eq(itemsTable.companyId, cid),
      ))
      .where(and(...conditions))
      .orderBy(desc(productionOrdersTable.createdAt)).limit(1000);
    res.json({
      rows,
      totals: {
        standardCost: rows.reduce((s, x) => s + Number(x.estimatedCost || 0), 0),
        actualCost: rows.reduce((s, x) => s + Number(x.actualCost || 0), 0),
      },
      basis: "shared_production_order_costs",
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

router.get("/reports", view, simpleReportHandler);
router.get("/reports/export", exportReport, simpleReportHandler);

export default router;