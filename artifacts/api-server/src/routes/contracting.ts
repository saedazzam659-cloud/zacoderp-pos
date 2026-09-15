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
  contractingOwnerContractsTable,
  contractingSubContractsTable,
  customersTable,
  branchesTable,
  itemsTable,
  itemUnitPricesTable,
  unitsTable,
  warehousesTable,
  stockBalanceTable,
  costCentersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { branchScopeSpread, extractAuth, getAllowedBranchIds, resolveCompanyId } from "../middleware/auth.js";
import { canAccessModule, requirePermission } from "../middleware/permissions.js";
import {
  contractingBranchAllowed,
  contractingMutationAction,
  contractingWarehouseAllowed,
} from "../lib/contracting-security.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import {
  multiplyQuantity,
  resolveItemUnitConversion,
  roundQuantity,
  UnitConversionError,
} from "../lib/unitConversion.js";
import {
  buildOutgoingBillJournal,
  buildIncomingBillJournal,
} from "../lib/contracting-journals.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(requirePermission("contracting", "view"));
// The old router only checked `contracting:view`, which made every legacy
// POST/PUT/DELETE reachable by any user who could read the module.  Keep reads
// behind the existing view gate, but map each mutation to the existing RBAC
// action so this router behaves like the newer routes.
router.use((req, res, next) => {
  const action = contractingMutationAction(req.method);
  if (!action) { next(); return; }
  requirePermission("contracting", action)(req, res, next);
});

// Helper: scope every query to the caller's company.
async function scope(req: any, res: any): Promise<number | null> {
  const cid = await resolveCompanyId(req, undefined);
  if (!cid) { res.status(400).json({ error: "لا يوجد شركة" }); return null; }
  return cid;
}

function projectBranchVisible(req: any, branchId: number | null | undefined): boolean {
  return contractingBranchAllowed(req.authUser, branchId);
}

function projectBranchCondition(req: any, branchColumn: any): any[] {
  const allowed = getAllowedBranchIds(req);
  if (allowed === null) return [];
  if (allowed.length === 0) return [sql`false`];
  return [inArray(branchColumn, allowed)];
}

function projectErrorStatus(error: string): number {
  return error === "ليس لديك صلاحية هذا الفرع" ? 403 : 400;
}

// Tenant-isolation guards. Each helper returns a string error message
// (in Arabic) if the referenced row is missing or doesn't belong to the
// caller's company / project — caller should 400 / 403 on non-null.
async function ensureProject(cid: number, projectId: number, req?: any): Promise<string | null> {
  if (!projectId) return "المشروع مطلوب";
  const [r] = await db.select({
    id: contractingProjectsTable.id,
    branchId: contractingProjectsTable.branchId,
  })
    .from(contractingProjectsTable)
    .where(and(eq(contractingProjectsTable.id, projectId), eq(contractingProjectsTable.companyId, cid)));
  if (r && req && !projectBranchVisible(req, r.branchId)) return "ليس لديك صلاحية هذا الفرع";
  return r ? null : "المشروع غير صالح";
}
async function ensureContractor(cid: number, contractorId: number): Promise<string | null> {
  if (!contractorId) return "المقاول الباطن مطلوب";
  const [r] = await db.select({ id: contractingContractorsTable.id })
    .from(contractingContractorsTable)
    .where(and(eq(contractingContractorsTable.id, contractorId), eq(contractingContractorsTable.companyId, cid)));
  return r ? null : "المقاول الباطن غير صالح";
}
async function ensureOwnerContract(cid: number, projectId: number, ocId: number): Promise<string | null> {
  const [r] = await db.select({ id: contractingOwnerContractsTable.id })
    .from(contractingOwnerContractsTable)
    .where(and(
      eq(contractingOwnerContractsTable.id, ocId),
      eq(contractingOwnerContractsTable.companyId, cid),
      eq(contractingOwnerContractsTable.projectId, projectId),
    ));
  return r ? null : "عقد المالك غير صالح";
}
async function ensureOwnerContractParent(
  cid: number,
  projectId: number,
  parentId: number,
  childId?: number,
): Promise<string | null> {
  if (!Number.isInteger(parentId) || parentId <= 0 || parentId === childId) {
    return "العقد الأساسي لأمر التغيير غير صالح";
  }
  const [parent] = await db.select({
    id: contractingOwnerContractsTable.id,
    contractType: contractingOwnerContractsTable.contractType,
  }).from(contractingOwnerContractsTable).where(and(
    eq(contractingOwnerContractsTable.id, parentId),
    eq(contractingOwnerContractsTable.companyId, cid),
    eq(contractingOwnerContractsTable.projectId, projectId),
  ));
  if (!parent || parent.contractType !== "main") return "العقد الأساسي يجب أن يكون عقداً رئيسياً من نفس المشروع";
  return null;
}
async function ensureCustomer(cid: number, customerId: number): Promise<string | null> {
  if (!customerId) return "العميل غير صالح";
  const [r] = await db.select({ id: customersTable.id })
    .from(customersTable)
    .where(and(eq(customersTable.id, customerId), eq(customersTable.companyId, cid)));
  return r ? null : "العميل غير صالح";
}

// Cost centres are company-scoped (there is no branch column on the
// catalogue). Branch visibility for a project is enforced by the project
// guards above. A new link must target an active centre; an existing link may
// remain inactive so editing unrelated project/bill fields never destroys a
// historical dimension.
async function ensureCostCenter(
  cid: number,
  costCenterId: number,
  existingCostCenterId?: number | null,
): Promise<string | null> {
  if (!Number.isInteger(costCenterId) || costCenterId <= 0) return "مركز التكلفة غير صالح";
  const [row] = await db.select({
    id: costCentersTable.id,
    isActive: costCentersTable.isActive,
  }).from(costCentersTable).where(and(
    eq(costCentersTable.id, costCenterId),
    eq(costCentersTable.companyId, cid),
  ));
  if (!row) return "مركز التكلفة غير صالح أو يخص شركة أخرى";
  if (!row.isActive && existingCostCenterId !== costCenterId) {
    return "لا يمكن اختيار مركز تكلفة غير نشط";
  }
  return null;
}

function parseOptionalCostCenterId(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : Number.NaN;
}

async function projectCostCenterId(cid: number, projectId: number): Promise<number | null> {
  const [project] = await db.select({
    costCenterId: contractingProjectsTable.costCenterId,
  }).from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, projectId),
    eq(contractingProjectsTable.companyId, cid),
  ));
  return project?.costCenterId == null ? null : Number(project.costCenterId);
}

/**
 * Resolve a project customer through the same company + branch visibility
 * boundary as the customer picker.  The fallback is intentionally limited to
 * the project's current link: it lets an already-linked legacy/inactive
 * customer remain unchanged when that customer is no longer selectable, but
 * never lets a caller create a new cross-branch link.
 */
async function findProjectCustomer(
  req: any,
  cid: number,
  customerId: number,
  existingCustomerId?: number | null,
) {
  if (!Number.isInteger(customerId) || customerId <= 0) return null;
  const [visible] = await db.select({
    id: customersTable.id,
    nameAr: customersTable.nameAr,
  }).from(customersTable).where(and(
    eq(customersTable.id, customerId),
    eq(customersTable.companyId, cid),
    ...branchScopeSpread(req, customersTable.branchId, undefined),
  ));
  if (visible) return visible;

  // Existing links are snapshots: do not break an old project just because
  // the customer became inactive or fell outside the current picker scope.
  if (existingCustomerId === customerId) {
    const [existing] = await db.select({
      id: customersTable.id,
      nameAr: customersTable.nameAr,
    }).from(customersTable).where(and(
      eq(customersTable.id, customerId),
      eq(customersTable.companyId, cid),
    ));
    return existing ?? null;
  }
  return null;
}

function parseOptionalCustomerId(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : Number.NaN;
}
async function ensureBranch(cid: number, branchId: number): Promise<string | null> {
  if (!branchId) return "الفرع غير صالح";
  const [r] = await db.select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)));
  return r ? null : "الفرع غير صالح";
}
async function ensureSubContract(cid: number, projectId: number, scId: number): Promise<string | null> {
  const [r] = await db.select({ id: contractingSubContractsTable.id, contractorId: contractingSubContractsTable.contractorId })
    .from(contractingSubContractsTable)
    .where(and(
      eq(contractingSubContractsTable.id, scId),
      eq(contractingSubContractsTable.companyId, cid),
      eq(contractingSubContractsTable.projectId, projectId),
    ));
  return r ? null : "عقد الباطن غير صالح";
}

const RESOURCE_TYPES = new Set(["labor", "equipment", "material", "subcontractor", "other"]);
const RESOURCE_STATUSES = new Set(["planned", "in_use", "consumed", "returned"]);
const PROJECT_TYPES = new Set(["building", "road", "infrastructure", "renovation", "maintenance", "other"]);
const PROJECT_STATUSES = new Set(["draft", "study", "contract", "planning", "in_progress", "on_hold", "completed", "cancelled"]);
const WORK_CATEGORIES = new Set(["earthworks", "excavation", "concrete", "steel", "masonry", "electrical", "plumbing", "mep", "finishing", "other"]);
const WORK_STATUSES = new Set(["pending", "in_progress", "completed", "done", "blocked"]);
const PROJECT_STATUS_AR: Record<string, string> = {
  draft: "مسودة", study: "دراسة", contract: "متعاقد عليه", planning: "تخطيط",
  in_progress: "قيد التنفيذ", on_hold: "متوقفة", completed: "مكتملة", cancelled: "ملغاة",
};
const RESOURCE_TYPE_AR: Record<string, string> = {
  labor: "عمالة", equipment: "معدات", material: "مواد", subcontractor: "مقاول باطن", other: "أخرى",
};

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : Number.NaN;
}

function validateNonNegative(value: unknown, label: string): string | null {
  const n = finiteNumber(value);
  if (!Number.isFinite(n) || n < 0) return `${label} يجب أن يكون رقماً غير سالب`;
  return null;
}

function exactBaseQuantity(qty: unknown, factor: string): string {
  // PostgreSQL numeric cannot accept the resolver's exact repeating fraction
  // notation. Round only at the persistence boundary; the item graph itself
  // remains the source of truth for all future conversions.
  return roundQuantity(multiplyQuantity(String(qty ?? "0"), factor), 18, "half_up");
}

function roundedConversionFactor(factor: string): string {
  return roundQuantity(factor, 18, "half_up");
}

async function loadProjectForResource(cid: number, projectId: number, req?: any) {
  const [project] = await db.select({
    id: contractingProjectsTable.id,
    branchId: contractingProjectsTable.branchId,
  }).from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, projectId),
    eq(contractingProjectsTable.companyId, cid),
  ));
  if (project && req && !projectBranchVisible(req, project.branchId)) return null;
  return project ?? null;
}

async function ensureWarehouseForProject(cid: number, warehouseId: number, projectId: number) {
  const project = await loadProjectForResource(cid, projectId);
  if (!project) return { error: "المشروع غير صالح" as const };
  const [warehouse] = await db.select({
    id: warehousesTable.id,
    branchId: warehousesTable.branchId,
    isActive: warehousesTable.isActive,
    nameAr: warehousesTable.nameAr,
  }).from(warehousesTable).where(and(
    eq(warehousesTable.id, warehouseId),
    eq(warehousesTable.companyId, cid),
    eq(warehousesTable.isActive, true),
  ));
  if (!warehouse) return { error: "المخزن غير صالح أو غير نشط" as const };
  // Inventory options and resource allocations never fall back to a
  // company-wide/NULL-branch warehouse.  The project and warehouse must both
  // have the same branch, otherwise a caller could use another branch's
  // stock by choosing a central row.
  if (!contractingWarehouseAllowed(project.branchId, warehouse.branchId)) {
    return { error: "المخزن لا يتبع فرع المشروع" as const };
  }
  return { project, warehouse };
}

async function validateMaterialResource(
  cid: number,
  projectId: number,
  input: { itemId?: unknown; unitId?: unknown; warehouseId?: unknown; qty?: unknown },
) {
  const itemId = Number(input.itemId);
  const unitId = Number(input.unitId);
  const warehouseId = Number(input.warehouseId);
  if (!Number.isInteger(itemId) || itemId <= 0) return { error: "صنف المخزون مطلوب" as const };
  if (!Number.isInteger(unitId) || unitId <= 0) return { error: "وحدة الصنف مطلوبة" as const };
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) return { error: "المخزن مطلوب للمواد" as const };
  const qtyError = validateNonNegative(input.qty, "كمية المورد");
  if (qtyError) return { error: qtyError as string };
  if (Number(input.qty ?? 0) <= 0) return { error: "كمية المورد يجب أن تكون أكبر من صفر" as const };

  const warehouseResult = await ensureWarehouseForProject(cid, warehouseId, projectId);
  if ("error" in warehouseResult) return warehouseResult;
  const [item] = await db.select({
    id: itemsTable.id,
    nameAr: itemsTable.nameAr,
    code: itemsTable.code,
    itemType: itemsTable.itemType,
    status: itemsTable.status,
  }).from(itemsTable).where(and(
    eq(itemsTable.id, itemId),
    eq(itemsTable.companyId, cid),
    eq(itemsTable.status, "active"),
  ));
  if (!item || item.itemType !== "stock") return { error: "اختر صنف مخزون نشطاً من نفس الشركة" as const };

  try {
    const resolved = await resolveItemUnitConversion({ companyId: cid, itemId, unitId });
    const [unit] = await db.select({
      id: unitsTable.id,
      code: unitsTable.code,
      nameAr: unitsTable.nameAr,
    }).from(unitsTable).where(and(
      eq(unitsTable.id, unitId),
      eq(unitsTable.companyId, cid),
    ));
    if (!unit) return { error: "وحدة الصنف غير صالحة" as const };
    return {
      item,
      unit,
      warehouse: warehouseResult.warehouse,
      factor: resolved.factor,
      qtyBase: exactBaseQuantity(input.qty, resolved.factor),
    };
  } catch (error) {
    if (error instanceof UnitConversionError) {
      return { error: `وحدة الصنف غير صالحة: ${error.message}` as const };
    }
    throw error;
  }
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
      .where(and(
        eq(contractingProjectsTable.companyId, cid),
        ...projectBranchCondition(req, contractingProjectsTable.branchId),
      ))
      .orderBy(desc(contractingProjectsTable.createdAt));
    if (status) rows = rows.filter(r => r.status === status);
    if (search) rows = rows.filter(r =>
      r.nameAr.toLowerCase().includes(search) ||
      (r.nameEn ?? "").toLowerCase().includes(search) ||
      r.code.toLowerCase().includes(search) ||
      (r.clientName ?? "").toLowerCase().includes(search) ||
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
    if (!projectBranchVisible(req, row.branchId)) {
      res.status(403).json({ error: "ليس لديك صلاحية هذا الفرع" }); return;
    }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

router.post("/projects", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body as any;
    if (!b?.nameAr) { res.status(400).json({ error: "اسم المشروع مطلوب" }); return; }
    const projectType = String(b.projectType ?? "building");
    const projectStatus = String(b.status ?? "draft");
    if (!PROJECT_TYPES.has(projectType)) { res.status(400).json({ error: "نوع المشروع غير صالح" }); return; }
    if (!PROJECT_STATUSES.has(projectStatus)) { res.status(400).json({ error: "حالة المشروع غير صالحة" }); return; }
    if (b.branchId != null) {
      const branchError = await ensureBranch(cid, Number(b.branchId));
      if (branchError) { res.status(400).json({ error: branchError }); return; }
    }
    if (!projectBranchVisible(req, b.branchId ?? null)) {
      res.status(403).json({ error: "ليس لديك صلاحية هذا الفرع" }); return;
    }
    const customerId = parseOptionalCustomerId(b.customerId);
    if (Number.isNaN(customerId)) {
      res.status(400).json({ error: "العميل غير صالح" }); return;
    }
    let clientName = b.clientName ?? null;
    if (customerId != null) {
      if (!canAccessModule(req.authUser, "customers", "view")) {
        res.status(403).json({ error: "لا تملك صلاحية عرض العملاء" }); return;
      }
      const customer = await findProjectCustomer(req, cid, customerId);
      if (!customer) { res.status(400).json({ error: "العميل غير صالح أو غير متاح لهذا الفرع" }); return; }
      // Always persist the selected customer's current display name as a
      // snapshot. Never infer a link from a legacy clientName.
      clientName = customer.nameAr;
    }
    const costCenterId = parseOptionalCostCenterId(b.costCenterId);
    if (Number.isNaN(costCenterId)) {
      res.status(400).json({ error: "مركز التكلفة غير صالح" }); return;
    }
    if (costCenterId != null) {
      const costCenterError = await ensureCostCenter(cid, costCenterId);
      if (costCenterError) { res.status(400).json({ error: costCenterError }); return; }
    }
    for (const [value, label] of [
      [b.contractValue, "قيمة العقد"],
      [b.plannedBudget, "الميزانية"],
      [b.actualCost, "التكلفة الفعلية"],
      [b.progressPercent, "نسبة الإنجاز"],
    ] as const) {
      const error = validateNonNegative(value ?? 0, label);
      if (error) { res.status(400).json({ error }); return; }
    }
    if (Number(b.progressPercent ?? 0) > 100) {
      res.status(400).json({ error: "نسبة الإنجاز يجب ألا تتجاوز 100" }); return;
    }

    // Auto code — pull from the configured "contracting_project" sequence
    // when the client did not supply one. The legacy contract required both
    // nameAr + code; we now relax the code requirement so the engine can
    // assign it. Tenants without a configured sequence still must supply
    // a code (the original 400 below preserves that behaviour).
    let code: string;
    if (b.code) {
      code = String(b.code);
    } else {
      const seq = await nextSequenceNumber(cid, "contracting_project", {
        branchId: b.branchId ?? null,
        userId:   req.authUser?.id ?? null,
        refTable: "contracting_projects",
      });
      if (seq) {
        code = seq;
      } else {
        res.status(400).json({ error: "كود المشروع مطلوب (لا يوجد مسلسل مهيأ لمشاريع المقاولات)" });
        return;
      }
    }

    const [row] = await db.insert(contractingProjectsTable).values({
      companyId: cid,
      branchId: b.branchId ?? null,
      code,
      nameAr: String(b.nameAr),
      nameEn: b.nameEn ?? null,
      customerId: customerId ?? null,
      costCenterId: costCenterId ?? null,
      clientName,
      location:   b.location   ?? null,
      projectType,
      status: projectStatus,
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
    const [prev] = await db.select().from(contractingProjectsTable)
      .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, cid)));
    if (!prev) { res.status(404).json({ error: "غير موجود" }); return; }
    if (!projectBranchVisible(req, prev.branchId)) {
      res.status(403).json({ error: "ليس لديك صلاحية هذا الفرع" }); return;
    }
    const updates: any = { updatedAt: new Date() };
    if (b.projectType !== undefined && !PROJECT_TYPES.has(String(b.projectType))) {
      res.status(400).json({ error: "نوع المشروع غير صالح" }); return;
    }
    if (b.status !== undefined && !PROJECT_STATUSES.has(String(b.status))) {
      res.status(400).json({ error: "حالة المشروع غير صالحة" }); return;
    }
    const passthroughText = ["nameAr","nameEn","clientName","location","description","status","projectType","code"];
    for (const k of passthroughText) if (b[k] !== undefined) updates[k] = b[k];
    const passthroughNum = ["contractValue","plannedBudget","actualCost","progressPercent"];
    for (const k of passthroughNum) {
      if (b[k] === undefined) continue;
      const error = validateNonNegative(b[k], k);
      if (error) { res.status(400).json({ error }); return; }
      if (k === "progressPercent" && Number(b[k]) > 100) {
        res.status(400).json({ error: "نسبة الإنجاز يجب ألا تتجاوز 100" }); return;
      }
      updates[k] = String(b[k]);
    }
    if (b.branchId !== undefined) {
      if (b.branchId != null) {
        const branchError = await ensureBranch(cid, Number(b.branchId));
        if (branchError) { res.status(400).json({ error: branchError }); return; }
      }
      if (!projectBranchVisible(req, b.branchId)) {
        res.status(403).json({ error: "ليس لديك صلاحية هذا الفرع" }); return;
      }
      updates.branchId = b.branchId;
    }
    if (b.plannedStartDate !== undefined) updates.plannedStartDate = b.plannedStartDate;
    if (b.plannedEndDate   !== undefined) updates.plannedEndDate   = b.plannedEndDate;

    if (b.customerId !== undefined) {
      const customerId = parseOptionalCustomerId(b.customerId);
      if (Number.isNaN(customerId)) {
        res.status(400).json({ error: "العميل غير صالح" }); return;
      }
      if (customerId == null) {
        // An explicit clear is an unlinked legacy project. Keep the supplied
        // snapshot/name untouched; clients may intentionally preserve it.
        updates.customerId = null;
      } else {
        const isExistingLink = prev.customerId === customerId;
        if (!isExistingLink && !canAccessModule(req.authUser, "customers", "view")) {
          res.status(403).json({ error: "لا تملك صلاحية عرض العملاء" }); return;
        }
        const customer = await findProjectCustomer(req, cid, customerId, prev.customerId);
        if (!customer) {
          res.status(400).json({ error: "العميل غير صالح أو غير متاح لهذا الفرع" });
          return;
        }
        updates.customerId = customerId;
        // Do not allow an arbitrary free-text value to masquerade as the
        // selected customer; the snapshot comes from the tenant-scoped row.
        updates.clientName = customer.nameAr;
      }
    }
    if (b.costCenterId !== undefined) {
      const costCenterId = parseOptionalCostCenterId(b.costCenterId);
      if (Number.isNaN(costCenterId)) {
        res.status(400).json({ error: "مركز التكلفة غير صالح" }); return;
      }
      if (costCenterId == null) {
        updates.costCenterId = null;
      } else {
        const costCenterError = await ensureCostCenter(cid, costCenterId, prev.costCenterId);
        if (costCenterError) { res.status(400).json({ error: costCenterError }); return; }
        updates.costCenterId = costCenterId;
      }
    }

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
        title: `تغيير حالة المشروع إلى: ${PROJECT_STATUS_AR[b.status] ?? "غير محددة"}`,
        description: `من ${PROJECT_STATUS_AR[prev.status] ?? "غير محددة"} إلى ${PROJECT_STATUS_AR[b.status] ?? "غير محددة"}`,
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
    const projectError = await ensureProject(cid, id, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    const category = String(b.category ?? "other");
    const status = String(b.status ?? "pending");
    if (!WORK_CATEGORIES.has(category)) { res.status(400).json({ error: "تصنيف البند غير صالح" }); return; }
    if (!WORK_STATUSES.has(status)) { res.status(400).json({ error: "حالة البند غير صالحة" }); return; }
    const plannedQty = Number(b.plannedQty ?? 0);
    const unitCost   = Number(b.unitCost   ?? 0);
    const actualQty = Number(b.actualQty ?? 0);
    const progress = Number(b.progressPercent ?? 0);
    if (![plannedQty, unitCost, actualQty, progress].every(Number.isFinite) || plannedQty < 0 || unitCost < 0 || actualQty < 0 || progress < 0 || progress > 100) {
      res.status(400).json({ error: "كميات وتكلفة ونسبة الإنجاز البند غير صالحة" }); return;
    }
    const [row] = await db.insert(contractingWorkItemsTable).values({
      companyId: cid,
      projectId,
      code: b.code ?? null,
      nameAr: String(b.nameAr),
      category,
      unit: b.unit ?? "m3",
      plannedQty: String(plannedQty),
      actualQty:  String(actualQty),
      unitCost:   String(unitCost),
      totalPlannedCost: String(plannedQty * unitCost),
      totalActualCost:  String(actualQty * unitCost),
      progressPercent: String(progress),
      plannedStartDate: b.plannedStartDate ?? null,
      plannedEndDate:   b.plannedEndDate   ?? null,
      status,
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
    const [current] = await db.select().from(contractingWorkItemsTable)
      .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    if (b.category !== undefined && !WORK_CATEGORIES.has(String(b.category))) {
      res.status(400).json({ error: "تصنيف البند غير صالح" }); return;
    }
    if (b.status !== undefined && !WORK_STATUSES.has(String(b.status))) {
      res.status(400).json({ error: "حالة البند غير صالحة" }); return;
    }
    const upd: any = { updatedAt: new Date() };
    for (const k of ["code","nameAr","category","unit","status","notes"]) if (b[k] !== undefined) upd[k] = b[k];
    for (const k of ["plannedQty","actualQty","unitCost","progressPercent"]) {
      if (b[k] === undefined) continue;
      const error = validateNonNegative(b[k], k);
      if (error) { res.status(400).json({ error }); return; }
      if (k === "progressPercent" && Number(b[k]) > 100) {
        res.status(400).json({ error: "نسبة الإنجاز يجب ألا تتجاوز 100" }); return;
      }
      upd[k] = String(b[k]);
    }
    if (b.contractorId !== undefined) upd.contractorId = b.contractorId;
    if (b.plannedStartDate !== undefined) upd.plannedStartDate = b.plannedStartDate;
    if (b.plannedEndDate   !== undefined) upd.plannedEndDate   = b.plannedEndDate;

    // Recompute totals if any input changed.
    if (b.plannedQty !== undefined || b.unitCost !== undefined || b.actualQty !== undefined) {
      const pq = Number(b.plannedQty ?? current.plannedQty);
      const aq = Number(b.actualQty  ?? current.actualQty);
      const uc = Number(b.unitCost   ?? current.unitCost);
      upd.totalPlannedCost = String(pq * uc);
      upd.totalActualCost  = String(aq * uc);
    }

    const [row] = await db.update(contractingWorkItemsTable).set(upd)
      .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)))
      .returning();
    if (!row) { res.status(404).json({ error: "غير موجود" }); return; }

    // After updating a work item, recompute parent project progress as
    // weighted average (by planned cost) so the project headline metric
    // tracks reality without manual sync.
    const items = await db.select().from(contractingWorkItemsTable)
      .where(and(
        eq(contractingWorkItemsTable.projectId, row.projectId),
        eq(contractingWorkItemsTable.companyId, cid),
      ));
    const totalWeight = items.reduce((s, i) => s + Number(i.totalPlannedCost), 0);
    const weighted = totalWeight > 0
      ? items.reduce((s, i) => s + Number(i.progressPercent) * Number(i.totalPlannedCost), 0) / totalWeight
      : items.reduce((s, i) => s + Number(i.progressPercent), 0) / Math.max(1, items.length);
    const actualSum = items.reduce((s, i) => s + Number(i.totalActualCost), 0);
    await db.update(contractingProjectsTable).set({
      progressPercent: String(Math.round(weighted * 100) / 100),
      actualCost:      String(Math.round(actualSum * 100) / 100),
      updatedAt: new Date(),
    }).where(and(
      eq(contractingProjectsTable.id, row.projectId),
      eq(contractingProjectsTable.companyId, cid),
    ));

    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/work-items/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [current] = await db.select({ projectId: contractingWorkItemsTable.projectId })
      .from(contractingWorkItemsTable)
      .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    await db.delete(contractingWorkItemsTable)
      .where(and(eq(contractingWorkItemsTable.id, id), eq(contractingWorkItemsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── RESOURCES ───────────────────
// Inventory picker for material planning. It exposes only active stock items,
// their item-owned unit graph, and warehouses visible to the project's branch.
// No stock movement is created by this read endpoint or by resource CRUD.
router.get("/resources/inventory-options", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.query.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      res.status(400).json({ error: "المشروع مطلوب" }); return;
    }
    const project = await loadProjectForResource(cid, projectId, req);
    if (!project) { res.status(400).json({ error: "المشروع غير صالح" }); return; }

    const items = await db.select({
      id: itemsTable.id,
      code: itemsTable.code,
      nameAr: itemsTable.nameAr,
      unitId: itemsTable.unitId,
    }).from(itemsTable).where(and(
      eq(itemsTable.companyId, cid),
      eq(itemsTable.itemType, "stock"),
      eq(itemsTable.status, "active"),
    )).orderBy(itemsTable.nameAr);

    const itemIds = items.map((item) => item.id);
    const links = itemIds.length === 0 ? [] : await db.select().from(itemUnitPricesTable)
      .where(and(
        eq(itemUnitPricesTable.companyId, cid),
        inArray(itemUnitPricesTable.itemId, itemIds),
      ));
    const unitIds = new Set<number>();
    for (const item of items) if (item.unitId != null) unitIds.add(item.unitId);
    for (const link of links) unitIds.add(link.unitId);
    const units = unitIds.size === 0 ? [] : await db.select({
      id: unitsTable.id,
      code: unitsTable.code,
      nameAr: unitsTable.nameAr,
    }).from(unitsTable).where(and(
      eq(unitsTable.companyId, cid),
      inArray(unitsTable.id, [...unitIds]),
    ));
    const unitsById = new Map(units.map((unit) => [unit.id, unit]));

    const materialItems = [];
    for (const item of items) {
      const candidateIds = new Set<number>();
      if (item.unitId != null) candidateIds.add(item.unitId);
      for (const link of links) {
        if (link.itemId === item.id && link.isActive) candidateIds.add(link.unitId);
      }
      const legalUnits = [];
      for (const unitId of candidateIds) {
        const unit = unitsById.get(unitId);
        if (!unit) continue;
        try {
          const resolved = await resolveItemUnitConversion({ companyId: cid, itemId: item.id, unitId });
          legalUnits.push({
            id: unit.id,
            code: unit.code,
            nameAr: unit.nameAr,
            factor: roundedConversionFactor(resolved.factor),
            isBase: resolved.baseUnitId === unit.id,
          });
        } catch (error) {
          // A malformed/ambiguous graph must not be made usable by guessing a
          // catalog factor. It simply remains absent from the picker.
          if (!(error instanceof UnitConversionError)) throw error;
        }
      }
      legalUnits.sort((a, b) => Number(b.isBase) - Number(a.isBase) || a.nameAr.localeCompare(b.nameAr, "ar"));
      if (legalUnits.length > 0) {
        const base = legalUnits.find((unit) => unit.isBase) ?? legalUnits[0];
        materialItems.push({
          ...item,
          baseUnitId: base.id,
          baseUnit: base,
          units: legalUnits,
        });
      }
    }

    const warehouseConditions: any[] = [
      eq(warehousesTable.companyId, cid),
      eq(warehousesTable.isActive, true),
    ];
    if (project.branchId == null) {
      warehouseConditions.push(sql`false`);
    } else {
      warehouseConditions.push(eq(warehousesTable.branchId, project.branchId));
    }
    const warehouses = await db.select({
      id: warehousesTable.id,
      code: warehousesTable.code,
      nameAr: warehousesTable.nameAr,
      branchId: warehousesTable.branchId,
    }).from(warehousesTable).where(and(...warehouseConditions)).orderBy(warehousesTable.nameAr);
    const warehouseIds = warehouses.map((warehouse) => warehouse.id);
    const balances = warehouseIds.length === 0 ? [] : await db.select({
      itemId: stockBalanceTable.itemId,
      warehouseId: stockBalanceTable.warehouseId,
      qtyBase: stockBalanceTable.qty,
      avgCost: stockBalanceTable.avgCost,
    }).from(stockBalanceTable).where(and(
      eq(stockBalanceTable.companyId, cid),
      inArray(stockBalanceTable.warehouseId, warehouseIds),
    ));
    res.json({
      projectBranchId: project.branchId,
      items: materialItems,
      warehouses,
      balances,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

router.get("/resources", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    const resourceProject = projectId !== null ? await loadProjectForResource(cid, projectId, req) : null;
    if (projectId !== null && !resourceProject) {
      res.status(400).json({ error: "المشروع غير صالح" }); return;
    }
    const conds: any[] = [eq(contractingResourcesTable.companyId, cid)];
    if (projectId !== null) conds.push(eq(contractingResourcesTable.projectId, projectId));
    const warehouseVisibility = resourceProject?.branchId != null
      ? eq(warehousesTable.branchId, resourceProject.branchId)
      : undefined;
    if (projectId === null) {
      const allowedBranches = getAllowedBranchIds(req);
      if (allowedBranches !== null) {
        if (allowedBranches.length === 0) conds.push(sql`false`);
        else conds.push(inArray(contractingProjectsTable.branchId, allowedBranches));
      }
    }
    const rows = await db.select({
      resource: contractingResourcesTable,
      itemNameAr: itemsTable.nameAr,
      itemCode: itemsTable.code,
      unitNameAr: unitsTable.nameAr,
      warehouseNameAr: warehousesTable.nameAr,
      availableStockBase: stockBalanceTable.qty,
    }).from(contractingResourcesTable)
      .leftJoin(contractingProjectsTable, and(
        eq(contractingResourcesTable.projectId, contractingProjectsTable.id),
        eq(contractingProjectsTable.companyId, cid),
      ))
      .leftJoin(itemsTable, and(
        eq(contractingResourcesTable.itemId, itemsTable.id),
        eq(itemsTable.companyId, cid),
      ))
      .leftJoin(unitsTable, and(
        eq(contractingResourcesTable.unitId, unitsTable.id),
        eq(unitsTable.companyId, cid),
      ))
      .leftJoin(warehousesTable, and(
        eq(contractingResourcesTable.warehouseId, warehousesTable.id),
        eq(warehousesTable.companyId, cid),
        ...(warehouseVisibility ? [warehouseVisibility] : []),
      ))
      .leftJoin(stockBalanceTable, and(
        eq(contractingResourcesTable.itemId, stockBalanceTable.itemId),
        eq(contractingResourcesTable.warehouseId, stockBalanceTable.warehouseId),
        eq(stockBalanceTable.companyId, cid),
        ...(warehouseVisibility ? [warehouseVisibility] : []),
      ))
      .where(and(...conds))
      .orderBy(desc(contractingResourcesTable.createdAt));
    res.json(rows.map((row) => ({
      ...row.resource,
      itemNameAr: row.itemNameAr,
      itemCode: row.itemCode,
      unitNameAr: row.unitNameAr,
      warehouseNameAr: row.warehouseNameAr,
      availableStockBase: row.availableStockBase ?? null,
    })));
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/resources", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body as any;
    if (!b || (String(b.type ?? "material") !== "material" && !b.name)) {
      res.status(400).json({ error: "الاسم مطلوب للموارد غير المادية" }); return;
    }
    if (!RESOURCE_TYPES.has(String(b.type ?? "material"))) {
      res.status(400).json({ error: "نوع المورد غير صالح" }); return;
    }
    if (!RESOURCE_STATUSES.has(String(b.status ?? "planned"))) {
      res.status(400).json({ error: "حالة المورد غير صالحة" }); return;
    }
    const projectId = b.projectId == null ? null : Number(b.projectId);
    if (projectId != null) {
      if (!Number.isInteger(projectId)) {
        res.status(400).json({ error: "المشروع غير صالح" }); return;
      }
      const projectError = await ensureProject(cid, projectId, req);
      if (projectError) {
        res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
      }
    }
    const qtyError = validateNonNegative(b.qty, "كمية المورد");
    const costError = validateNonNegative(b.unitCost, "سعر الوحدة");
    if (qtyError || costError || Number(b.qty ?? 0) <= 0) {
      res.status(400).json({ error: qtyError || costError || "كمية المورد يجب أن تكون أكبر من صفر" }); return;
    }
    const type = String(b.type ?? "material");
    let material: Awaited<ReturnType<typeof validateMaterialResource>> | null = null;
    if (type === "material") {
      if (projectId == null) { res.status(400).json({ error: "المشروع مطلوب للمواد" }); return; }
      material = await validateMaterialResource(cid, projectId, b);
      if (!material || !("item" in material)) {
        const error = material && "error" in material ? material.error : "بيانات المادة غير صالحة";
        res.status(400).json({ error }); return;
      }
    } else if (b.itemId != null || b.unitId != null || b.warehouseId != null) {
      res.status(400).json({ error: "ربط الصنف والمخزن مخصص للمواد فقط" }); return;
    }
    const qty = Number(b.qty);
    const uc  = Number(b.unitCost ?? 0);
    const materialData: any = type === "material" ? material : null;
    const [row] = await db.insert(contractingResourcesTable).values({
      companyId: cid,
      projectId,
      name: materialData ? materialData.item.nameAr : String(b.name),
      type,
      itemId: materialData?.item.id ?? null,
      unitId: materialData?.unit.id ?? null,
      warehouseId: materialData?.warehouse.id ?? null,
      unit: materialData?.unit.code ?? String(b.unit ?? "hr"),
      qty: String(qty),
      qtyBase: materialData?.qtyBase ?? String(qty),
      conversionFactor: materialData?.factor ? roundedConversionFactor(materialData.factor) : "1",
      unitCost:  String(uc),
      totalCost: String(qty * uc),
      supplierId: b.supplierId ?? null,
      status: String(b.status ?? "planned"),
      notes: b.notes ?? null,
    }).returning();
    if (b.projectId) {
      await logEvent({
        companyId: cid, projectId: b.projectId, userId: req.authUser!.id,
        eventType: "resource_planned",
        title: `تخطيط مورد: ${row.name}`,
        description: `النوع: ${RESOURCE_TYPE_AR[row.type] ?? "غير محدد"} — الكمية: ${row.qty} ${row.unit} — دون حركة مخزون`,
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
    const [cur] = await db.select().from(contractingResourcesTable)
      .where(and(eq(contractingResourcesTable.id, id), eq(contractingResourcesTable.companyId, cid)));
    if (!cur) { res.status(404).json({ error: "غير موجود" }); return; }
    if (cur.projectId != null) {
      const currentProjectError = await ensureProject(cid, cur.projectId, req);
      if (currentProjectError) {
        res.status(projectErrorStatus(currentProjectError)).json({ error: currentProjectError }); return;
      }
    }
    const upd: any = { updatedAt: new Date() };
    for (const k of ["name","type","unit","status","notes"]) if (b[k] !== undefined) upd[k] = b[k];
    for (const k of ["qty","unitCost"]) if (b[k] !== undefined) upd[k] = String(b[k]);
    const type = String(b.type ?? cur.type);
    if (!RESOURCE_TYPES.has(type)) { res.status(400).json({ error: "نوع المورد غير صالح" }); return; }
    const status = String(b.status ?? cur.status);
    if (!RESOURCE_STATUSES.has(status)) { res.status(400).json({ error: "حالة المورد غير صالحة" }); return; }
    if (b.qty !== undefined) {
      const error = validateNonNegative(b.qty, "كمية المورد");
      if (error || Number(b.qty) <= 0) { res.status(400).json({ error: error || "كمية المورد يجب أن تكون أكبر من صفر" }); return; }
    }
    if (b.unitCost !== undefined) {
      const error = validateNonNegative(b.unitCost, "سعر الوحدة");
      if (error) { res.status(400).json({ error }); return; }
    }
    const projectId = b.projectId !== undefined ? (b.projectId == null ? null : Number(b.projectId)) : cur.projectId;
    if (projectId != null) {
      if (!Number.isInteger(projectId)) {
        res.status(400).json({ error: "المشروع غير صالح" }); return;
      }
      const projectError = await ensureProject(cid, projectId, req);
      if (projectError) {
        res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
      }
    }
    if (b.projectId !== undefined) upd.projectId = projectId;
    if (b.supplierId !== undefined) upd.supplierId = b.supplierId;
    if (type === "material") {
      const materialInput = {
        itemId: b.itemId ?? cur.itemId,
        unitId: b.unitId ?? cur.unitId,
        warehouseId: b.warehouseId ?? cur.warehouseId,
        qty: b.qty ?? cur.qty,
      };
      if (projectId == null) { res.status(400).json({ error: "المشروع مطلوب للمواد" }); return; }
      const material = await validateMaterialResource(cid, projectId, materialInput);
      if (!material || !("item" in material)) {
        const error = material && "error" in material ? material.error : "بيانات المادة غير صالحة";
        res.status(400).json({ error }); return;
      }
      const materialData: any = material;
      upd.itemId = materialData.item.id;
      upd.unitId = materialData.unit.id;
      upd.warehouseId = materialData.warehouse.id;
      upd.unit = materialData.unit.code;
      upd.qtyBase = materialData.qtyBase;
      upd.conversionFactor = roundedConversionFactor(materialData.factor);
      upd.name = materialData.item.nameAr;
    } else if (b.itemId != null || b.unitId != null || b.warehouseId != null) {
      res.status(400).json({ error: "ربط الصنف والمخزن مخصص للمواد فقط" }); return;
    } else {
      // Switching a legacy/material allocation to a non-stock resource clears
      // its inventory links instead of leaving a stale stock relationship.
      upd.itemId = null;
      upd.unitId = null;
      upd.warehouseId = null;
    }
    const finalQty = Number(b.qty ?? cur.qty);
    const finalUnitCost = Number(b.unitCost ?? cur.unitCost);
    if (!Number.isFinite(finalQty) || !Number.isFinite(finalUnitCost)) {
      res.status(400).json({ error: "الكمية وسعر الوحدة يجب أن يكونا أرقاماً" }); return;
    }
    upd.totalCost = String(finalQty * finalUnitCost);
    if (type !== "material") {
      upd.qtyBase = String(finalQty);
      upd.conversionFactor = "1";
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
    const [current] = await db.select({ projectId: contractingResourcesTable.projectId })
      .from(contractingResourcesTable)
      .where(and(eq(contractingResourcesTable.id, id), eq(contractingResourcesTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    if (current.projectId != null) {
      const projectError = await ensureProject(cid, current.projectId, req);
      if (projectError) {
        res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
      }
    }
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

// ─────────────────── OWNER CONTRACTS (عقود المالك) ───────────────────
// Formal contracts between our company and the project's owner/client.
// One project usually has 1 main + N change orders.
router.get("/projects/:projectId/owner-contracts", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    const rows = await db.select().from(contractingOwnerContractsTable)
      .where(and(
        eq(contractingOwnerContractsTable.companyId, cid),
        eq(contractingOwnerContractsTable.projectId, projectId),
      ))
      .orderBy(desc(contractingOwnerContractsTable.contractDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/projects/:projectId/owner-contracts", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    if (!b?.contractNumber || !b?.contractDate) {
      res.status(400).json({ error: "رقم العقد وتاريخه مطلوبان" }); return;
    }
    const projErr = await ensureProject(cid, projectId, req);
    if (projErr) { res.status(projectErrorStatus(projErr)).json({ error: projErr }); return; }
    if (b.customerId) {
      const cusErr = await ensureCustomer(cid, Number(b.customerId));
      if (cusErr) { res.status(400).json({ error: cusErr }); return; }
    }
    const contractType = String(b.contractType ?? "main");
    const parentContractId = b.parentContractId == null || b.parentContractId === ""
      ? null : Number(b.parentContractId);
    if (parentContractId != null) {
      if (contractType !== "change_order" && contractType !== "addendum") {
        res.status(400).json({ error: "العقد الأساسي يخصص لأمر تغيير أو ملحق فقط" }); return;
      }
      const parentError = await ensureOwnerContractParent(cid, projectId, parentContractId);
      if (parentError) { res.status(400).json({ error: parentError }); return; }
    }
    const value = Number(b.value ?? 0);
    const advancePct = Number(b.advancePercent ?? 0);
    const advancePay = b.advancePayment !== undefined ? Number(b.advancePayment) : Math.round((value * advancePct / 100) * 100) / 100;
    const [row] = await db.insert(contractingOwnerContractsTable).values({
      companyId: cid, projectId,
      customerId: b.customerId ? Number(b.customerId) : null,
      clientName: b.clientName ?? null,
      contractNumber: String(b.contractNumber),
      contractDate: b.contractDate,
      signedAt: b.signedAt ?? null,
      contractType,
      parentContractId,
      value:            String(value),
      advancePayment:   String(advancePay),
      advancePercent:   String(advancePct),
      retentionPercent: String(b.retentionPercent ?? 5),
      vatPercent:       String(b.vatPercent ?? 15),
      durationDays: Number(b.durationDays ?? 0),
      startDate: b.startDate ?? null,
      endDate:   b.endDate   ?? null,
      paymentTerms: b.paymentTerms ?? null,
      scopeOfWork:  b.scopeOfWork  ?? null,
      penaltiesClause: b.penaltiesClause ?? null,
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    }).returning();
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "owner_contract_created",
      title: `عقد مالك جديد رقم ${row.contractNumber}`,
      description: `قيمة العقد: ${row.value} ر.س`,
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/owner-contracts/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const [cur] = await db.select().from(contractingOwnerContractsTable)
      .where(and(eq(contractingOwnerContractsTable.id, id), eq(contractingOwnerContractsTable.companyId, cid)));
    if (!cur) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, cur.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    const upd: any = { updatedAt: new Date() };
    for (const k of ["contractNumber","contractType","status","clientName","paymentTerms","scopeOfWork","penaltiesClause","notes"]) {
      if (b[k] !== undefined) upd[k] = b[k];
    }
    if (b.parentContractId !== undefined) {
      const parentContractId = b.parentContractId == null || b.parentContractId === ""
        ? null : Number(b.parentContractId);
      const contractType = String(b.contractType ?? cur.contractType);
      if (parentContractId != null) {
        if (contractType !== "change_order" && contractType !== "addendum") {
          res.status(400).json({ error: "العقد الأساسي يخصص لأمر تغيير أو ملحق فقط" }); return;
        }
        const parentError = await ensureOwnerContractParent(cid, cur.projectId, parentContractId, id);
        if (parentError) { res.status(400).json({ error: parentError }); return; }
      }
      upd.parentContractId = parentContractId;
    } else if (b.contractType !== undefined && !["change_order", "addendum"].includes(String(b.contractType))) {
      upd.parentContractId = null;
    }
    for (const k of ["contractDate","signedAt","startDate","endDate"]) {
      if (b[k] !== undefined) upd[k] = b[k] || null;
    }
    if (b.customerId !== undefined) {
      if (b.customerId) {
        const cusErr = await ensureCustomer(cid, Number(b.customerId));
        if (cusErr) { res.status(400).json({ error: cusErr }); return; }
      }
      upd.customerId = b.customerId ? Number(b.customerId) : null;
    }
    if (b.durationDays !== undefined) upd.durationDays = Number(b.durationDays);
    for (const k of ["value","advancePayment","advancePercent","retentionPercent","vatPercent"]) {
      if (b[k] !== undefined) upd[k] = String(b[k]);
    }
    const [row] = await db.update(contractingOwnerContractsTable).set(upd)
      .where(and(eq(contractingOwnerContractsTable.id, id), eq(contractingOwnerContractsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/owner-contracts/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [current] = await db.select({ projectId: contractingOwnerContractsTable.projectId })
      .from(contractingOwnerContractsTable)
      .where(and(eq(contractingOwnerContractsTable.id, id), eq(contractingOwnerContractsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    await db.delete(contractingOwnerContractsTable)
      .where(and(eq(contractingOwnerContractsTable.id, id), eq(contractingOwnerContractsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── SUB-CONTRACTS (عقود المقاولين الباطنين) ───────────────────
router.get("/projects/:projectId/sub-contracts", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    const rows = await db.select().from(contractingSubContractsTable)
      .where(and(
        eq(contractingSubContractsTable.companyId, cid),
        eq(contractingSubContractsTable.projectId, projectId),
      ))
      .orderBy(desc(contractingSubContractsTable.contractDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/projects/:projectId/sub-contracts", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    if (!b?.contractNumber || !b?.contractDate || !b?.contractorId) {
      res.status(400).json({ error: "رقم العقد، التاريخ، والمقاول الباطن مطلوبة" }); return;
    }
    const projErr = await ensureProject(cid, projectId, req);
    if (projErr) { res.status(projectErrorStatus(projErr)).json({ error: projErr }); return; }
    const conErr  = await ensureContractor(cid, Number(b.contractorId));
    if (conErr)  { res.status(400).json({ error: conErr }); return; }
    const value = Number(b.value ?? 0);
    const advancePct = Number(b.advancePercent ?? 0);
    const advancePay = b.advancePayment !== undefined ? Number(b.advancePayment) : Math.round((value * advancePct / 100) * 100) / 100;
    const [row] = await db.insert(contractingSubContractsTable).values({
      companyId: cid, projectId,
      contractorId: Number(b.contractorId),
      contractNumber: String(b.contractNumber),
      contractDate: b.contractDate,
      signedAt: b.signedAt ?? null,
      scopeOfWork: b.scopeOfWork ?? null,
      value:            String(value),
      advancePayment:   String(advancePay),
      advancePercent:   String(advancePct),
      retentionPercent: String(b.retentionPercent ?? 5),
      vatPercent:       String(b.vatPercent ?? 15),
      durationDays: Number(b.durationDays ?? 0),
      startDate: b.startDate ?? null,
      endDate:   b.endDate   ?? null,
      paymentTerms: b.paymentTerms ?? null,
      penaltiesClause: b.penaltiesClause ?? null,
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    }).returning();
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "sub_contract_created",
      title: `عقد مقاول باطن جديد رقم ${row.contractNumber}`,
      description: `قيمة العقد: ${row.value} ر.س`,
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/sub-contracts/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const [cur] = await db.select().from(contractingSubContractsTable)
      .where(and(eq(contractingSubContractsTable.id, id), eq(contractingSubContractsTable.companyId, cid)));
    if (!cur) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, cur.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    const upd: any = { updatedAt: new Date() };
    for (const k of ["contractNumber","status","scopeOfWork","paymentTerms","penaltiesClause","notes"]) {
      if (b[k] !== undefined) upd[k] = b[k];
    }
    for (const k of ["contractDate","signedAt","startDate","endDate"]) {
      if (b[k] !== undefined) upd[k] = b[k] || null;
    }
    if (b.contractorId !== undefined) {
      const conErr = await ensureContractor(cid, Number(b.contractorId));
      if (conErr) { res.status(400).json({ error: conErr }); return; }
      upd.contractorId = Number(b.contractorId);
    }
    if (b.durationDays !== undefined) upd.durationDays = Number(b.durationDays);
    for (const k of ["value","advancePayment","advancePercent","retentionPercent","vatPercent"]) {
      if (b[k] !== undefined) upd[k] = String(b[k]);
    }
    const [row] = await db.update(contractingSubContractsTable).set(upd)
      .where(and(eq(contractingSubContractsTable.id, id), eq(contractingSubContractsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.delete("/sub-contracts/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [current] = await db.select({ projectId: contractingSubContractsTable.projectId })
      .from(contractingSubContractsTable)
      .where(and(eq(contractingSubContractsTable.id, id), eq(contractingSubContractsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    await db.delete(contractingSubContractsTable)
      .where(and(eq(contractingSubContractsTable.id, id), eq(contractingSubContractsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ─────────────────── PROGRESS BILLS (مستخلصات) ───────────────────
// Bills now carry a `direction`:
//   outgoing — مستخلص يصدره مكتبنا للمالك (claim against client)
//   incoming — مستخلص يصدره المقاول الباطن لنا (we owe a sub-contractor)
// Filter via ?direction=outgoing|incoming. Defaults to all.

// Company-wide bills list (across all projects). Powers the standalone
// "المستخلصات" screen so finance can track every progress bill in one place.
// Filters: direction, status, projectId, contractorId, dateFrom, dateTo.
// Joins contractor + project so the table can render names without N+1 calls.
router.get("/bills", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const direction    = String(req.query.direction    ?? "");
    const status       = String(req.query.status       ?? "");
    const projectIdQ   = req.query.projectId    ? Number(req.query.projectId)    : null;
    const contractorIdQ= req.query.contractorId ? Number(req.query.contractorId) : null;
    const dateFrom     = req.query.dateFrom ? String(req.query.dateFrom) : null;
    const dateTo       = req.query.dateTo   ? String(req.query.dateTo)   : null;

    const conds: any[] = [eq(contractingProgressBillsTable.companyId, cid)];
    if (direction === "outgoing" || direction === "incoming") {
      conds.push(eq(contractingProgressBillsTable.direction, direction));
    }
    if (status) conds.push(eq(contractingProgressBillsTable.status, status));
    if (projectIdQ) {
      const projectError = await ensureProject(cid, projectIdQ, req);
      if (projectError) {
        res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
      }
      conds.push(eq(contractingProgressBillsTable.projectId, projectIdQ));
    }
    if (contractorIdQ) conds.push(eq(contractingProgressBillsTable.contractorId, contractorIdQ));
    if (dateFrom) conds.push(sql`${contractingProgressBillsTable.billDate} >= ${dateFrom}`);
    if (dateTo)   conds.push(sql`${contractingProgressBillsTable.billDate} <= ${dateTo}`);

    const rows = await db.select({
      id:               contractingProgressBillsTable.id,
      projectId:        contractingProgressBillsTable.projectId,
      projectCode:      contractingProjectsTable.code,
      projectName:      contractingProjectsTable.nameAr,
      direction:        contractingProgressBillsTable.direction,
      costCenterId:     contractingProgressBillsTable.costCenterId,
      contractorId:     contractingProgressBillsTable.contractorId,
      contractorName:   contractingContractorsTable.name,
      billNumber:       contractingProgressBillsTable.billNumber,
      billType:         contractingProgressBillsTable.billType,
      billDate:         contractingProgressBillsTable.billDate,
      progressPercent:  contractingProgressBillsTable.progressPercent,
      grossAmount:      contractingProgressBillsTable.grossAmount,
      retentionAmount:  contractingProgressBillsTable.retentionAmount,
      previousPaid:     contractingProgressBillsTable.previousPaid,
      dueAmount:        contractingProgressBillsTable.dueAmount,
      vatAmount:        contractingProgressBillsTable.vatAmount,
      netAmount:        contractingProgressBillsTable.netAmount,
      paidAmount:       contractingProgressBillsTable.paidAmount,
      status:           contractingProgressBillsTable.status,
    })
      .from(contractingProgressBillsTable)
      // Joins are scoped by companyId in addition to the FK so a stray cross-tenant
      // FK (legacy import, manual data fix, etc.) can NEVER leak another company's
      // project/contractor name into the response. Defense in depth on top of the
      // base WHERE.
       .leftJoin(contractingProjectsTable, and(
        eq(contractingProgressBillsTable.projectId, contractingProjectsTable.id),
        eq(contractingProjectsTable.companyId, cid),
      ))
      .leftJoin(contractingContractorsTable, and(
        eq(contractingProgressBillsTable.contractorId, contractingContractorsTable.id),
        eq(contractingContractorsTable.companyId, cid),
      ))
      .where(and(...conds, ...projectBranchCondition(req, contractingProjectsTable.branchId)))
      .orderBy(desc(contractingProgressBillsTable.billDate),
               desc(contractingProgressBillsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.get("/projects/:projectId/bills", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    const direction = String(req.query.direction ?? "");
    const conds = [
      eq(contractingProgressBillsTable.companyId, cid),
      eq(contractingProgressBillsTable.projectId, projectId),
    ];
    if (direction === "outgoing" || direction === "incoming") {
      conds.push(eq(contractingProgressBillsTable.direction, direction));
    }
    const rows = await db.select().from(contractingProgressBillsTable)
      .where(and(...conds))
      .orderBy(desc(contractingProgressBillsTable.billDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.post("/projects/:projectId/bills", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    if (!b?.billDate) {
      res.status(400).json({ error: "تاريخ المستخلص مطلوب" }); return;
    }
    if (["approved", "posted", "partially_paid", "paid"].includes(String(b.status)) || Number(b.paidAmount ?? 0) !== 0) {
      res.status(409).json({ error: "لا يمكن إنشاء مستخلص بترحيل أو سداد مباشر؛ استخدم مسار المحاسبة لاعتماد المستخلص وتسويته" });
      return;
    }

    // Auto bill number — pull from the configured "contracting_bill"
    // sequence when the client did not supply one. Falls back to the
    // legacy "must-be-supplied" contract so existing tenants without a
    // sequence configured still get a clear error instead of an empty
    // billNumber being inserted.
    let billNumber: string;
    if (b.billNumber) {
      billNumber = String(b.billNumber);
    } else {
      const seq = await nextSequenceNumber(cid, "contracting_bill", {
        branchId: b.branchId ?? null,
        userId:   req.authUser?.id ?? null,
        refTable: "contracting_progress_bills",
      });
      if (seq) {
        billNumber = seq;
      } else {
        res.status(400).json({ error: "رقم المستخلص مطلوب (لا يوجد مسلسل مهيأ لمستخلصات المقاولات)" });
        return;
      }
    }

    const direction = b.direction === "incoming" ? "incoming" : "outgoing";
    if (direction === "incoming" && !b.contractorId) {
      res.status(400).json({ error: "المقاول الباطن مطلوب لمستخلصات الباطن" }); return;
    }

    // Tenant-isolation: verify every referenced FK is in the same company
    // (and the same project for contract links). Without these guards a
    // crafted body could attach a bill to another tenant's project/contract.
    const projErr = await ensureProject(cid, projectId, req);
    if (projErr) { res.status(projectErrorStatus(projErr)).json({ error: projErr }); return; }
    const requestedCostCenterId = parseOptionalCostCenterId(b.costCenterId);
    if (Number.isNaN(requestedCostCenterId)) {
      res.status(400).json({ error: "مركز التكلفة غير صالح" }); return;
    }
    // Resolve inheritance once and persist the effective value. Future
    // project-default changes must not affect this bill's accounting.
    const effectiveCostCenterId = requestedCostCenterId === undefined
      ? await projectCostCenterId(cid, projectId)
      : requestedCostCenterId;
    if (effectiveCostCenterId != null) {
      const costCenterError = await ensureCostCenter(
        cid,
        effectiveCostCenterId,
        requestedCostCenterId === undefined ? effectiveCostCenterId : undefined,
      );
      if (costCenterError) { res.status(400).json({ error: costCenterError }); return; }
    }
    if (b.contractorId) {
      const e = await ensureContractor(cid, Number(b.contractorId));
      if (e) { res.status(400).json({ error: e }); return; }
    }
    if (b.ownerContractId) {
      const e = await ensureOwnerContract(cid, projectId, Number(b.ownerContractId));
      if (e) { res.status(400).json({ error: e }); return; }
    }
    if (b.subcontractorContractId) {
      const e = await ensureSubContract(cid, projectId, Number(b.subcontractorContractId));
      if (e) { res.status(400).json({ error: e }); return; }
    }

    // Server-side computation. Client may send raw values; we recompute the
    // derived ones here so the math is consistent and tamper-resistant.
    const gross     = Number(b.grossAmount ?? 0);
    const retPct    = Number(b.retentionPercent ?? 0);
    const vatPct    = b.vatPercent !== undefined ? Number(b.vatPercent) : 15;
    const prevPaid  = Number(b.previousPaid ?? 0);
    const retAmount = Math.round((gross * retPct / 100) * 100) / 100;
    const dueAmount = Math.max(0, Math.round((gross - retAmount - prevPaid) * 100) / 100);
    const vatAmount = Math.round((dueAmount * vatPct / 100) * 100) / 100;
    const netAmount = Math.round((dueAmount + vatAmount) * 100) / 100;

    const [row] = await db.insert(contractingProgressBillsTable).values({
      companyId: cid, projectId,
      costCenterId: effectiveCostCenterId,
      direction,
      contractorId: b.contractorId ? Number(b.contractorId) : null,
      ownerContractId:         b.ownerContractId         ? Number(b.ownerContractId)         : null,
      subcontractorContractId: b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
      billNumber,
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
      vatPercent:       String(vatPct),
      vatAmount:        String(vatAmount),
      netAmount:        String(netAmount),
      paidAmount:       String(b.paidAmount ?? 0),
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    }).returning();
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "bill_submitted",
      title: `${direction === "incoming" ? "مستخلص باطن" : "مستخلص مالك"} جديد رقم ${row.billNumber}`,
      description: `صافي: ${row.netAmount} ر.س`,
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
    if (["approved", "posted", "partially_paid", "paid"].includes(String(cur.status)) ||
        ["approved", "posted", "partially_paid", "paid"].includes(String(b.status)) || b.paidAmount !== undefined) {
      res.status(409).json({ error: "لا يمكن تعديل حالة مالية أو مبلغ السداد من المسار القديم؛ استخدم اعتماد/تسوية المحاسبة" });
      return;
    }
    const projectError = await ensureProject(cid, cur.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }

    const upd: any = { updatedAt: new Date() };
    const requestedCostCenterId = parseOptionalCostCenterId(b.costCenterId);
    if (Number.isNaN(requestedCostCenterId)) {
      res.status(400).json({ error: "مركز التكلفة غير صالح" }); return;
    }
    // Omitted means inherit the current project default; the UI sends null
    // explicitly when the user cleared this saved bill snapshot.
    const effectiveCostCenterId = requestedCostCenterId === undefined
      ? await projectCostCenterId(cid, cur.projectId)
      : requestedCostCenterId;
    if (effectiveCostCenterId != null) {
      const costCenterError = await ensureCostCenter(
        cid,
        effectiveCostCenterId,
        requestedCostCenterId === undefined ? effectiveCostCenterId : cur.costCenterId,
      );
      if (costCenterError) { res.status(400).json({ error: costCenterError }); return; }
    }
    upd.costCenterId = effectiveCostCenterId;
    for (const k of ["billNumber","billType","status","notes"]) if (b[k] !== undefined) upd[k] = b[k];
    if (b.billDate !== undefined) upd.billDate = b.billDate;
    if (b.fromDate !== undefined) upd.fromDate = b.fromDate;
    if (b.toDate   !== undefined) upd.toDate   = b.toDate;

    // Direction is immutable on update — flipping a bill across the
    // outgoing/incoming boundary doesn't make business sense and would
    // bypass the create-time direction-vs-contractorId invariant.
    if (b.direction !== undefined && b.direction !== cur.direction) {
      res.status(400).json({ error: "لا يمكن تغيير اتجاه المستخلص بعد إنشائه" }); return;
    }
    const direction = cur.direction;

    // Tenant-isolation guards on FK changes.
    if (b.contractorId !== undefined) {
      if (b.contractorId) {
        const e = await ensureContractor(cid, Number(b.contractorId));
        if (e) { res.status(400).json({ error: e }); return; }
      }
      upd.contractorId = b.contractorId ? Number(b.contractorId) : null;
    }
    if (b.ownerContractId !== undefined) {
      if (b.ownerContractId) {
        const e = await ensureOwnerContract(cid, cur.projectId, Number(b.ownerContractId));
        if (e) { res.status(400).json({ error: e }); return; }
      }
      upd.ownerContractId = b.ownerContractId ? Number(b.ownerContractId) : null;
    }
    if (b.subcontractorContractId !== undefined) {
      if (b.subcontractorContractId) {
        const e = await ensureSubContract(cid, cur.projectId, Number(b.subcontractorContractId));
        if (e) { res.status(400).json({ error: e }); return; }
      }
      upd.subcontractorContractId = b.subcontractorContractId ? Number(b.subcontractorContractId) : null;
    }

    // Re-enforce: incoming bills MUST keep a valid contractor (whether
    // because the column was unchanged or because the user just changed it).
    const finalContractorId = upd.contractorId !== undefined ? upd.contractorId : cur.contractorId;
    if (direction === "incoming" && !finalContractorId) {
      res.status(400).json({ error: "المقاول الباطن مطلوب لمستخلصات الباطن" }); return;
    }

    const gross    = b.grossAmount      !== undefined ? Number(b.grossAmount)      : Number(cur.grossAmount);
    const retPct   = b.retentionPercent !== undefined ? Number(b.retentionPercent) : Number(cur.retentionPercent);
    const prevPaid = b.previousPaid     !== undefined ? Number(b.previousPaid)     : Number(cur.previousPaid);
    // VAT % is now persisted on the bill row. If the client doesn't send a
    // new value we fall back to the stored value — never to a hard-coded
    // 15% — so editing a non-15% bill no longer silently rewrites its tax.
    const vatPct   = b.vatPercent       !== undefined ? Number(b.vatPercent)       : Number(cur.vatPercent ?? 15);
    upd.vatPercent = String(vatPct);
    const retAmount = Math.round((gross * retPct / 100) * 100) / 100;
    const dueAmount = Math.max(0, Math.round((gross - retAmount - prevPaid) * 100) / 100);
    const vatAmount = Math.round((dueAmount * vatPct / 100) * 100) / 100;
    const netAmount = Math.round((dueAmount + vatAmount) * 100) / 100;
    upd.grossAmount      = String(gross);
    upd.retentionPercent = String(retPct);
    upd.retentionAmount  = String(retAmount);
    upd.previousPaid     = String(prevPaid);
    upd.dueAmount        = String(dueAmount);
    upd.vatAmount        = String(vatAmount);
    upd.netAmount        = String(netAmount);
    if (b.progressPercent !== undefined) upd.progressPercent = String(b.progressPercent);
    if (b.paidAmount !== undefined) upd.paidAmount = String(b.paidAmount);
    const becomingApproved = b.status === "approved" && cur.status !== "approved";
    if (becomingApproved) {
      upd.approvedAt = new Date();
      upd.approvedByUserId = req.authUser!.id;
    }
    if (b.status === "paid" && cur.status !== "paid") {
      upd.paidAt = new Date();
      // If paidAmount wasn't explicitly provided, mark the full net as paid
      // so the dashboard's "paid vs due" math doesn't show 0 next to a
      // bill the user just marked as paid.
      if (b.paidAmount === undefined) upd.paidAmount = String(netAmount);
    }

    const [row] = await db.update(contractingProgressBillsTable).set(upd)
      .where(and(eq(contractingProgressBillsTable.id, id), eq(contractingProgressBillsTable.companyId, cid)))
      .returning();

    // ─── IFRS 15 auto-post on approval ───────────────────────────────────
    // Trigger only on the status transition (not subsequent edits while
    // already approved). Both engines are idempotent (no-op when
    // journalEntryId is already set), so a stray re-trigger is harmless.
    // Errors here surface as 500 — we deliberately do NOT swallow them so
    // the user discovers an unmapped account immediately instead of having
    // a silent gap in the books.
    if (becomingApproved && !row.journalEntryId) {
      if (direction === "outgoing") {
        await buildOutgoingBillJournal(cid, id);
      } else {
        await buildIncomingBillJournal(cid, id);
      }
    }

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
    const [current] = await db.select({
      projectId: contractingProgressBillsTable.projectId,
      status: contractingProgressBillsTable.status,
      journalEntryId: contractingProgressBillsTable.journalEntryId,
    })
      .from(contractingProgressBillsTable)
      .where(and(eq(contractingProgressBillsTable.id, id), eq(contractingProgressBillsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    if (["approved", "posted", "partially_paid", "paid"].includes(String(current.status)) || current.journalEntryId) {
      res.status(409).json({ error: "لا يمكن حذف مستخلص له أثر مالي؛ استخدم فك الاعتماد من مسار المحاسبة" });
      return;
    }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const [current] = await db.select({ projectId: contractingRisksTable.projectId })
      .from(contractingRisksTable)
      .where(and(eq(contractingRisksTable.id, id), eq(contractingRisksTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
    const [current] = await db.select({ projectId: contractingRisksTable.projectId })
      .from(contractingRisksTable)
      .where(and(eq(contractingRisksTable.id, id), eq(contractingRisksTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "غير موجود" }); return; }
    const projectError = await ensureProject(cid, current.projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
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
      .where(and(
        eq(contractingProjectsTable.companyId, cid),
        ...projectBranchCondition(req, contractingProjectsTable.branchId),
      ));
    const visibleProjectIds = projects.map((project) => project.id);
    const risks = visibleProjectIds.length === 0 ? [] : await db.select().from(contractingRisksTable)
      .where(and(
        eq(contractingRisksTable.companyId, cid),
        inArray(contractingRisksTable.projectId, visibleProjectIds),
      ));
    const recentEvents = visibleProjectIds.length === 0 ? [] : await db.select().from(contractingEventsTable)
      .where(and(
        eq(contractingEventsTable.companyId, cid),
        inArray(contractingEventsTable.projectId, visibleProjectIds),
      ))
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
