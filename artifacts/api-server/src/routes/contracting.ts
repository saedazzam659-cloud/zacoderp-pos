// Contracting routes
// Contracting / Construction ERP — CRUD routes
//
// Permission key: `contracting`. Multi-tenant by companyId.
// Numeric fields are returned as strings (Drizzle numeric → string) which
// the frontend formats with toLocaleString. Dates as YYYY-MM-DD.
// End route overview
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
  contractingBillLinesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { branchScopeSpread, extractAuth, getAllowedBranchIds, resolveCompanyId } from "../middleware/auth.js";
import { canAccessModule, requirePermission } from "../middleware/permissions.js";
import {
  contractingBranchAllowed,
  contractingMutationAction,
  contractingWarehouseError,
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
import {
  ensureProjectContractSelection,
  type BillDirection,
} from "../lib/contracting-project-contract-integrity.js";
import { ensureContractingAccountingTables } from "../lib/contracting-accounting-storage.js";
import { ensureContractingBillDetailsTables } from "../lib/contracting-bill-details-service.js";
import { ensureContractingBoqTables } from "../lib/contracting-boq-service.js";
import { ensureContractingGuaranteeTables } from "../lib/contracting-guarantees-storage.js";
import {
  aggregateContractProgressAmounts,
  priorCertifiedContractGross,
  calculateAdvanceRecoveryCents,
  type CertifiedContractProgressBill,
} from "../lib/contracting-accounting-math.js";
import {
  canOverrideAdvanceRecovery,
  getAdvanceRecoveryPreview,
} from "../lib/contracting-accounting-service.js";
import { assertBillContractScope } from "../lib/contracting-bill-contracts.js";
import {
  contractCreateFingerprint,
  createContractIdempotently,
  parseContractCreateIdempotencyKey,
} from "../lib/contracting-contract-create-idempotency.js";
import {
  billCreateFingerprint,
  createBillIdempotently,
  parseBillCreateIdempotencyKey,
} from "../lib/contracting-bill-create-idempotency.js";
import {
  getContractingSettings,
  updateContractingSettings,
  validateContractingSettingAccounts,
} from "../lib/contracting-settings.js";
import {
  ensureContractingProjectIntegrity,
  getContractingIntegrityDiagnostics,
} from "../lib/contracting-integrity.js";
import { ensureContractingExecutionSchema } from "../lib/contracting-execution-storage.js";
import {
  createExecutionWorkItem,
  deleteResourceAnalysis,
  listExecutionWorkItems,
  syncExecutionProjectProgress,
  updateExecutionWorkItem,
  upsertResourceAnalysis,
} from "../lib/contracting-execution-service.js";

const router = Router();
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});
router.use(async (_req, res, next) => {
  try {
    await ensureContractingBoqTables();
    await ensureContractingProjectIntegrity();
    // This runs against the ambient request database. Do not replace it with a
    // central-only boot promise: external tenant databases require the same
    // additive readiness before any execution query references new columns.
    await ensureContractingExecutionSchema();
    await ensureContractingGuaranteeTables();
    next();
  } catch (caught) {
    next(caught);
  }
});
router.use(requirePermission("contracting", "view"));
// The old router only checked `contracting:view`, which made every legacy
// POST/PUT/DELETE reachable by any user who could read the module.  Keep reads
// behind the existing view gate, but map each mutation to the existing RBAC
// action so this router behaves like the newer routes.
router.use((req, res, next) => {
  const action = contractingMutationAction(req.method);
  // This POST is a read-only calculation despite using POST for its structured
  // request body; it must remain available with the existing view capability.
  if (req.method === "POST" && req.path.endsWith("/advance-recovery-preview")) {
    next();
    return;
  }
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

// ─────────────────── MODULE SETTINGS (إعدادات المقاولات) ──────────────
// The router-wide view gate protects reads; the mutation gate above maps PUT
// to contracting:edit.  Account ids are checked against the tenant and must
// point at active posting accounts before they are persisted.
router.get("/settings", async (req, res) => {
  try {
    const cid = await scope(req, res);
    if (!cid) return;
    res.json(await getContractingSettings(cid));
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر تحميل إعدادات المقاولات" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const cid = await scope(req, res);
    if (!cid) return;
    const patch = req.body ?? {};
    await validateContractingSettingAccounts(cid, patch);
    res.json(await updateContractingSettings(cid, patch, req.authUser?.id ?? null));
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر حفظ إعدادات المقاولات" });
  }
});

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
async function ensureProjectParent(
  cid: number,
  parentId: number,
  branchId: number | null,
  req: any,
  childId?: number,
  preserveLegacyDepth = false,
): Promise<string | null> {
  if (!Number.isInteger(parentId) || parentId <= 0 || parentId === childId) {
    return "المشروع الأب غير صالح";
  }
  const [parent] = await db.select({
    id: contractingProjectsTable.id,
    branchId: contractingProjectsTable.branchId,
    parentId: contractingProjectsTable.parentId,
  }).from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, parentId),
    eq(contractingProjectsTable.companyId, cid),
  ));
  if (!parent) return "المشروع الأب لا يتبع نفس الشركة";
  if (!preserveLegacyDepth && parent.parentId != null) {
    return "يدعم هيكل المشاريع مستويين فقط: مشروع رئيسي ثم مشروع فرعي";
  }
  if (!projectBranchVisible(req, parent.branchId)) return "ليس لديك صلاحية فرع المشروع الأب";
  if ((parent.branchId == null ? null : Number(parent.branchId)) !== branchId) {
    return "المشروع الأب يجب أن يكون ضمن نفس الفرع ونطاق الرؤية";
  }
  if (childId != null) {
      const [existingChild] = await db.select({ id: contractingProjectsTable.id })
        .from(contractingProjectsTable)
        .where(and(
          eq(contractingProjectsTable.companyId, cid),
          eq(contractingProjectsTable.parentId, childId),
        )).limit(1);
      if (!preserveLegacyDepth && existingChild) {
        return "لا يمكن جعل مشروع رئيسي له مشاريع فرعية تابعاً لمشروع آخر";
      }
    const result = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM contracting_projects
         WHERE id = ${parentId} AND company_id = ${cid}
        UNION ALL
        SELECT p.id, p.parent_id
          FROM contracting_projects p
          JOIN ancestors a ON p.id = a.parent_id
         WHERE p.company_id = ${cid}
      )
      SELECT 1 FROM ancestors WHERE id = ${childId} LIMIT 1
    `);
    const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
    if (rows.length) return "لا يمكن نقل المشروع تحت أحد فروعه لأن ذلك ينشئ دورة";
  }
  return null;
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
async function ensureSubContractParent(
  cid: number,
  projectId: number,
  parentId: number,
  childId?: number,
): Promise<string | null> {
  if (!Number.isInteger(parentId) || parentId <= 0 || parentId === childId) {
    return "العقد الأساسي لأمر تغيير الباطن غير صالح";
  }
  const [parent] = await db.select({
    id: contractingSubContractsTable.id,
    contractType: contractingSubContractsTable.contractType,
  }).from(contractingSubContractsTable).where(and(
    eq(contractingSubContractsTable.id, parentId),
    eq(contractingSubContractsTable.companyId, cid),
    eq(contractingSubContractsTable.projectId, projectId),
  ));
  if (!parent || parent.contractType !== "main") return "العقد الأساسي يجب أن يكون عقد باطن رئيسياً من نفس المشروع";
  return null;
}

async function assertChangeOrderReductionSafe(
  cid: number,
  projectId: number,
  contractId: number,
  direction: "owner" | "subcontract",
  executor: any = db,
) {
  const result = await executor.execute(sql`
    SELECT 1
      FROM contracting_contract_boq_lines child
      JOIN contracting_contract_boq_lines base
        ON base.id = child.base_line_id
       AND base.company_id = child.company_id
      JOIN contracting_bill_lines bl ON bl.boq_line_id = base.id
      JOIN contracting_progress_bills pb ON pb.id = bl.bill_id
     WHERE child.company_id = ${cid}
       AND child.project_id = ${projectId}
       AND bl.company_id = ${cid}
       AND pb.company_id = ${cid}
       AND pb.project_id = ${projectId}
       AND ${direction === "owner"
    ? sql`child.owner_contract_id = ${contractId}`
    : sql`child.subcontractor_contract_id = ${contractId}`}
       AND child.quantity_delta < 0
       AND pb.status IN ('approved', 'certified', 'posted', 'partially_paid', 'paid')
       AND (
         SELECT COALESCE(SUM(bl2.current_qty), 0)
           FROM contracting_bill_lines bl2
           JOIN contracting_progress_bills pb2 ON pb2.id = bl2.bill_id
          WHERE bl2.boq_line_id = base.id
            AND pb2.status IN ('approved', 'certified', 'posted', 'partially_paid', 'paid')
       ) > base.quantity + child.quantity_delta + 0.0001
     LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  if (rows.length > 0) throw new Error("لا يمكن اعتماد خفض كمية أدنى من الكمية المنفذة والمعتمدة");
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
  projectBranchId?: number | null,
) {
  if (!Number.isInteger(customerId) || customerId <= 0) return null;
  const [visible] = await db.select({
    id: customersTable.id,
    nameAr: customersTable.nameAr,
  }).from(customersTable).where(and(
    eq(customersTable.id, customerId),
    eq(customersTable.companyId, cid),
    ...branchScopeSpread(req, customersTable.branchId, projectBranchId),
  ));
  if (visible) return visible;

  // Existing links are snapshots: do not break an old project just because
  // the customer became inactive or fell outside the current picker scope.
  if (existingCustomerId === customerId) {
    const [existing] = await db.select({
      id: customersTable.id,
      nameAr: customersTable.nameAr,
      branchId: customersTable.branchId,
    }).from(customersTable).where(and(
      eq(customersTable.id, customerId),
      eq(customersTable.companyId, cid),
    ));
    if (
      existing
      && projectBranchId != null
      && existing.branchId != null
      && Number(existing.branchId) !== Number(projectBranchId)
    ) return null;
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
async function ensureBranch(
  cid: number,
  branchId: number,
  allowInactive = false,
): Promise<string | null> {
  if (!Number.isInteger(branchId) || branchId <= 0) return "الفرع غير صالح";
  const [r] = await db.select({
    id: branchesTable.id,
    status: branchesTable.status,
  })
    .from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), eq(branchesTable.companyId, cid)));
  if (!r) return "الفرع غير صالح";
  if (!allowInactive && r.status !== "active") return "الفرع غير نشط";
  return null;
}

/**
 * A project branch is a persisted scope, not a display-only preference.
 * Changing it must never rewrite descendants or move already-posted history.
 * Legacy branchless projects can be assigned a branch when no posted financial
 * or stock history exists and every material resource is either shared or
 * already compatible with the requested branch.
 */
async function projectBranchChangeError(
  cid: number,
  projectId: number,
  previousBranchId: number | null,
  nextBranchId: number | null,
): Promise<string | null> {
  if (previousBranchId === nextBranchId) return null;

  // The accounting facade creates these additive tables lazily. Ensure they
  // exist before checking them so a project edit is safe on an older tenant.
  await ensureContractingAccountingTables();

  const [postedBill] = await db.select({ id: contractingProgressBillsTable.id })
    .from(contractingProgressBillsTable)
    .where(and(
      eq(contractingProgressBillsTable.companyId, cid),
      eq(contractingProgressBillsTable.projectId, projectId),
      or(
        inArray(contractingProgressBillsTable.status, [
          "approved", "posted", "paid", "partially_paid", "reversed",
        ]),
        sql`${contractingProgressBillsTable.journalEntryId} IS NOT NULL`,
      ),
    ))
    .limit(1);
  if (postedBill) {
    return "لا يمكن تغيير فرع المشروع بعد وجود مستخلص مالي مرحّل";
  }

  const postedSettlement = await db.execute(sql`
    SELECT id
      FROM contracting_accounting_settlements
     WHERE company_id = ${cid}
       AND project_id = ${projectId}
       AND status IN ('posted', 'approved', 'paid', 'partially_paid')
     LIMIT 1
  `);
  if (Array.isArray(postedSettlement.rows) && postedSettlement.rows.length > 0) {
    return "لا يمكن تغيير فرع المشروع بعد وجود تسوية مالية مرحّلة";
  }

  const postedMovement = await db.execute(sql`
    SELECT id
      FROM contracting_material_movements
     WHERE company_id = ${cid}
       AND project_id = ${projectId}
       AND status = 'posted'
     LIMIT 1
  `);
  if (Array.isArray(postedMovement.rows) && postedMovement.rows.length > 0) {
    return "لا يمكن تغيير فرع المشروع بعد وجود حركة مخزون مرحّلة";
  }

  const resources = await db.select({
    warehouseBranchId: warehousesTable.branchId,
  }).from(contractingResourcesTable)
    .leftJoin(warehousesTable, and(
      eq(contractingResourcesTable.warehouseId, warehousesTable.id),
      eq(warehousesTable.companyId, cid),
    ))
    .where(and(
      eq(contractingResourcesTable.companyId, cid),
      eq(contractingResourcesTable.projectId, projectId),
    ));
  const hasIncompatibleWarehouse = resources.some(({ warehouseBranchId }) =>
    warehouseBranchId != null
      && (nextBranchId == null || Number(warehouseBranchId) !== Number(nextBranchId)));
  if (hasIncompatibleWarehouse) {
    return "لا يمكن تغيير فرع المشروع لأن مورداً مرتبطاً بمخزن من فرع آخر";
  }
  return null;
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

async function contractBoqLineCount(
  cid: number,
  projectId: number,
  kind: "owner" | "subcontract",
  contractId: number,
  executor: any = db,
): Promise<number> {
  await ensureContractingBoqTables();
  const result = await executor.execute(kind === "owner" ? sql`
    SELECT count(*)::int AS count
      FROM contracting_contract_boq_lines
     WHERE company_id = ${cid} AND project_id = ${projectId}
       AND direction = 'owner' AND owner_contract_id = ${contractId}
  ` : sql`
    SELECT count(*)::int AS count
      FROM contracting_contract_boq_lines
     WHERE company_id = ${cid} AND project_id = ${projectId}
       AND direction = 'subcontract' AND subcontractor_contract_id = ${contractId}
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return Number(rows[0]?.count ?? 0);
}

async function ensureApprovedContract(
  cid: number,
  projectId: number,
  direction: BillDirection,
  ownerContractId: number | null,
  subcontractorContractId: number | null,
): Promise<string | null> {
  if (direction === "incoming") {
    const [contract] = await db.select({ status: contractingSubContractsTable.status })
      .from(contractingSubContractsTable).where(and(
        eq(contractingSubContractsTable.id, Number(subcontractorContractId)),
        eq(contractingSubContractsTable.companyId, cid),
        eq(contractingSubContractsTable.projectId, projectId),
      ));
    return contract?.status === "approved" ? null : "لا يمكن بدء التنفيذ أو إنشاء مستخلص قبل اعتماد عقد الباطن";
  }
  const [contract] = await db.select({ status: contractingOwnerContractsTable.status })
    .from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.id, Number(ownerContractId)),
      eq(contractingOwnerContractsTable.companyId, cid),
      eq(contractingOwnerContractsTable.projectId, projectId),
    ));
  return contract?.status === "approved" ? null : "لا يمكن بدء التنفيذ أو إنشاء مستخلص قبل اعتماد عقد المالك";
}

/**
 * A contract is normally created under one project and the project_id is
 * intentionally immutable once anything depends on it.  Keep the explicit
 * projectId edit path safe for older clients that still send the full form:
 * moving a contract with a child contract or bill would leave those
 * descendants pointing at a different project scope.
 */
async function contractProjectMoveError(
  cid: number,
  contractId: number,
  kind: "owner" | "subcontract",
  previousProjectId: number,
  nextProjectId: number,
  req: any,
): Promise<string | null> {
  if (previousProjectId === nextProjectId) return null;
  const projectError = await ensureProject(cid, nextProjectId, req);
  if (projectError) return projectError;

  if (kind === "owner") {
    const [child] = await db.select({ id: contractingOwnerContractsTable.id })
      .from(contractingOwnerContractsTable)
      .where(and(
        eq(contractingOwnerContractsTable.companyId, cid),
        eq(contractingOwnerContractsTable.parentContractId, contractId),
      ))
      .limit(1);
    const [bill] = await db.select({ id: contractingProgressBillsTable.id })
      .from(contractingProgressBillsTable)
      .where(and(
        eq(contractingProgressBillsTable.companyId, cid),
        eq(contractingProgressBillsTable.ownerContractId, contractId),
      ))
      .limit(1);
    if (child || bill) return "لا يمكن نقل عقد له عقود أو مستخلصات تابعة إلى مشروع آخر";
  } else {
    const [bill] = await db.select({ id: contractingProgressBillsTable.id })
      .from(contractingProgressBillsTable)
      .where(and(
        eq(contractingProgressBillsTable.companyId, cid),
        eq(contractingProgressBillsTable.subcontractorContractId, contractId),
      ))
      .limit(1);
    if (bill) return "لا يمكن نقل عقد له مستخلصات تابعة إلى مشروع آخر";
  }
  return null;
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

function validatePercentage(value: unknown, label: string): string | null {
  const n = finiteNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return `${label} يجب أن يكون بين 0 و100`;
  return null;
}

function validateAdvanceRecoveryMethod(value: unknown, label = "طريقة استرداد الدفعة المقدمة"): string | null {
  const method = String(value ?? "percentage");
  return method === "percentage" || method === "fixed"
    ? null
    : `${label} يجب أن تكون percentage أو fixed`;
}

function advanceRecoveryOverrideRequest(
  req: any,
  direction: BillDirection,
  body: any,
  existing?: any,
) {
  const hasAmount = Object.prototype.hasOwnProperty.call(body ?? {}, "advanceRecoveryOverrideAmount");
  const hasReason = Object.prototype.hasOwnProperty.call(body ?? {}, "advanceRecoveryOverrideReason");
  if (!hasAmount && !hasReason) {
    return { present: false, amount: existing?.advanceRecoveryOverrideAmount ?? null, reason: existing?.advanceRecoveryOverrideReason ?? null };
  }
  if (!canOverrideAdvanceRecovery(req, direction)) {
    throw Object.assign(new Error("ليس لديك صلاحية طلب استرداد سلفة استثنائياً"), { status: 403 });
  }
  const rawAmount = hasAmount ? body.advanceRecoveryOverrideAmount : existing?.advanceRecoveryOverrideAmount;
  const cleared = rawAmount == null || rawAmount === "";
  if (cleared) {
    return { present: true, amount: null, reason: null };
  }
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error("مبلغ استرداد السلفة الاستثنائي يجب أن يكون غير سالب"), { status: 422 });
  }
  const reason = String(hasReason ? body.advanceRecoveryOverrideReason : existing?.advanceRecoveryOverrideReason ?? "").trim();
  if (!reason) {
    throw Object.assign(new Error("سبب استرداد السلفة الاستثنائي مطلوب"), { status: 422 });
  }
  return { present: true, amount: String(amount), reason };
}

function calculateAdvancePayment(value: number, percent: number): number {
  return Math.round((value * percent / 100 + Number.EPSILON) * 100) / 100;
}

type AdvanceRecoverySettings = {
  enabled: boolean;
  percent: string;
  method: "percentage" | "fixed";
  fixedAmount: string;
  startProgressPercent: string;
  contractAdvanceAmount: string;
};

type RetentionSettings = {
  enabled: boolean;
  percent: string;
  capPercent: string;
};

async function contractRetentionSettings(
  companyId: number,
  projectId: number,
  direction: BillDirection,
  ownerContractId: number | null,
  subcontractorContractId: number | null,
): Promise<RetentionSettings | null> {
  if (direction === "incoming") {
    const [contract] = await db.select({
      enabled: contractingSubContractsTable.retentionEnabled,
      percent: contractingSubContractsTable.retentionPercent,
      capPercent: contractingSubContractsTable.retentionCapPercent,
    }).from(contractingSubContractsTable).where(and(
      eq(contractingSubContractsTable.companyId, companyId),
      eq(contractingSubContractsTable.projectId, projectId),
      eq(contractingSubContractsTable.id, Number(subcontractorContractId)),
    ));
    return contract ? {
      enabled: contract.enabled !== false,
      percent: String(contract.percent ?? "5"),
      capPercent: String(contract.capPercent ?? "100"),
    } : null;
  }
  const [contract] = await db.select({
    enabled: contractingOwnerContractsTable.retentionEnabled,
    percent: contractingOwnerContractsTable.retentionPercent,
    capPercent: contractingOwnerContractsTable.retentionCapPercent,
  }).from(contractingOwnerContractsTable).where(and(
    eq(contractingOwnerContractsTable.companyId, companyId),
    eq(contractingOwnerContractsTable.projectId, projectId),
    eq(contractingOwnerContractsTable.id, Number(ownerContractId)),
  ));
  return contract ? {
    enabled: contract.enabled !== false,
    percent: String(contract.percent ?? "5"),
    capPercent: String(contract.capPercent ?? "100"),
  } : null;
}

async function contractAdvanceRecoverySettings(
  companyId: number,
  projectId: number,
  direction: BillDirection,
  ownerContractId: number | null,
  subcontractorContractId: number | null,
): Promise<AdvanceRecoverySettings> {
  if (direction === "incoming") {
    const [contract] = await db.select({
      enabled: contractingSubContractsTable.advanceRecoveryEnabled,
      percent: contractingSubContractsTable.advanceRecoveryPercent,
      method: contractingSubContractsTable.advanceRecoveryMethod,
      fixedAmount: contractingSubContractsTable.advanceRecoveryFixedAmount,
      start: contractingSubContractsTable.advanceRecoveryStartProgressPercent,
      advancePayment: contractingSubContractsTable.advancePayment,
    }).from(contractingSubContractsTable).where(and(
      eq(contractingSubContractsTable.companyId, companyId),
      eq(contractingSubContractsTable.projectId, projectId),
      eq(contractingSubContractsTable.id, Number(subcontractorContractId)),
    ));
    return {
      enabled: Boolean(contract?.enabled),
      percent: String(contract?.percent ?? "0"),
      method: String(contract?.method ?? "percentage") as "percentage" | "fixed",
      fixedAmount: String(contract?.fixedAmount ?? "0"),
      startProgressPercent: String(contract?.start ?? "0"),
      contractAdvanceAmount: String(contract?.advancePayment ?? "0"),
    };
  }
  const [contract] = await db.select({
    enabled: contractingOwnerContractsTable.advanceRecoveryEnabled,
    percent: contractingOwnerContractsTable.advanceRecoveryPercent,
    method: contractingOwnerContractsTable.advanceRecoveryMethod,
    fixedAmount: contractingOwnerContractsTable.advanceRecoveryFixedAmount,
    start: contractingOwnerContractsTable.advanceRecoveryStartProgressPercent,
    advancePayment: contractingOwnerContractsTable.advancePayment,
  }).from(contractingOwnerContractsTable).where(and(
    eq(contractingOwnerContractsTable.companyId, companyId),
    eq(contractingOwnerContractsTable.projectId, projectId),
    eq(contractingOwnerContractsTable.id, Number(ownerContractId)),
  ));
  return {
    enabled: Boolean(contract?.enabled),
    percent: String(contract?.percent ?? "0"),
    method: String(contract?.method ?? "percentage") as "percentage" | "fixed",
    fixedAmount: String(contract?.fixedAmount ?? "0"),
    startProgressPercent: String(contract?.start ?? "0"),
    contractAdvanceAmount: String(contract?.advancePayment ?? "0"),
  };
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
  // Company-wide (NULL-branch) warehouses are visible from every branch,
  // matching inventory's read scope.  A branch-specific warehouse must still
  // belong to the project's branch.
  const warehouseError = contractingWarehouseError(project.branchId, warehouse.branchId);
  if (warehouseError) {
    return { error: warehouseError };
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

/**
 * Branch picker for the contracting project form.  This is deliberately
 * separate from the project list (which must remain an array for existing
 * clients) and returns only active, same-tenant branches in the caller's
 * authorized branch scope.
 */
router.get("/projects/options", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const conditions: any[] = [
      eq(branchesTable.companyId, cid),
      eq(branchesTable.status, "active"),
    ];
    const allowed = getAllowedBranchIds(req);
    if (allowed !== null) {
      if (allowed.length === 0) conditions.push(sql`false`);
      else conditions.push(inArray(branchesTable.id, allowed));
    }
    const branches = await db.select({
      id: branchesTable.id,
      code: branchesTable.code,
      nameAr: branchesTable.nameAr,
      nameEn: branchesTable.nameEn,
    }).from(branchesTable)
      .where(and(...conditions))
      .orderBy(branchesTable.code);
    const projects = await db.select({
      id: contractingProjectsTable.id,
      code: contractingProjectsTable.code,
      nameAr: contractingProjectsTable.nameAr,
      nameEn: contractingProjectsTable.nameEn,
      parentId: contractingProjectsTable.parentId,
      branchId: contractingProjectsTable.branchId,
    }).from(contractingProjectsTable).where(and(
      eq(contractingProjectsTable.companyId, cid),
      ...projectBranchCondition(req, contractingProjectsTable.branchId),
    )).orderBy(contractingProjectsTable.code);
    const integrityDiagnostics = await getContractingIntegrityDiagnostics(
      cid,
      projects.map((project) => project.id),
    );
    res.json({
      branches,
      projects,
      integrityDiagnostics,
    });
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
    if (b.branchId == null || b.branchId === "") {
      res.status(400).json({ error: "فرع المشروع مطلوب" }); return;
    }
    const branchId = Number(b.branchId);
    if (!Number.isInteger(branchId) || branchId <= 0) {
      res.status(400).json({ error: "الفرع غير صالح" }); return;
    }
    const projectType = String(b.projectType ?? "building");
    const projectStatus = String(b.status ?? "draft");
    if (!PROJECT_TYPES.has(projectType)) { res.status(400).json({ error: "نوع المشروع غير صالح" }); return; }
    if (!PROJECT_STATUSES.has(projectStatus)) { res.status(400).json({ error: "حالة المشروع غير صالحة" }); return; }
    const branchError = await ensureBranch(cid, branchId);
    if (branchError) { res.status(400).json({ error: branchError }); return; }
    if (!projectBranchVisible(req, branchId)) {
      res.status(403).json({ error: "ليس لديك صلاحية هذا الفرع" }); return;
    }
    const parentId = b.parentId == null || b.parentId === "" ? null : Number(b.parentId);
    if (parentId != null) {
      const parentError = await ensureProjectParent(cid, parentId, branchId, req);
      if (parentError) {
        res.status(parentError.includes("صلاحية") ? 403 : 400).json({ error: parentError }); return;
      }
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
      const customer = await findProjectCustomer(req, cid, customerId, undefined, branchId);
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
        branchId,
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

    const row = await db.transaction(async (tx) => {
      // Serialize hierarchy writes per tenant. The DB trigger repeats this
      // protection for direct SQL writers.
      await tx.execute(sql`SELECT id FROM companies WHERE id = ${cid} FOR UPDATE`);
      const [created] = await tx.insert(contractingProjectsTable).values({
        companyId: cid,
        branchId,
        parentId,
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
      return created;
    });
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
    let nextProjectBranchId = prev.branchId == null ? null : Number(prev.branchId);
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
      const nextBranchId = b.branchId == null || b.branchId === ""
        ? null
        : Number(b.branchId);
      if (b.branchId != null && b.branchId !== "" && !Number.isInteger(nextBranchId)) {
        res.status(400).json({ error: "الفرع غير صالح" }); return;
      }
      if (nextBranchId != null) {
        // An unchanged legacy link may point to a branch that was later
        // deactivated; preserve it while editing unrelated project fields.
        const unchanged = prev.branchId != null && Number(prev.branchId) === nextBranchId;
        const branchError = await ensureBranch(cid, nextBranchId, unchanged);
        if (branchError) { res.status(400).json({ error: branchError }); return; }
      }
      if (!projectBranchVisible(req, nextBranchId)) {
        res.status(403).json({ error: "ليس لديك صلاحية هذا الفرع" }); return;
      }
      const branchChangeError = await projectBranchChangeError(
        cid,
        id,
        prev.branchId == null ? null : Number(prev.branchId),
        nextBranchId,
      );
      if (branchChangeError) {
        res.status(409).json({ error: branchChangeError });
        return;
      }
      updates.branchId = nextBranchId;
      nextProjectBranchId = nextBranchId;
    }
    if (b.parentId !== undefined || b.branchId !== undefined) {
      const nextParentId = b.parentId === undefined
        ? prev.parentId
        : b.parentId == null || b.parentId === "" ? null : Number(b.parentId);
      if (nextParentId != null) {
        const parentError = await ensureProjectParent(
          cid,
          Number(nextParentId),
          nextProjectBranchId,
          req,
          id,
          b.parentId === undefined || Number(nextParentId) === Number(prev.parentId),
        );
        if (parentError) {
          res.status(parentError.includes("صلاحية") ? 403 : 400).json({ error: parentError }); return;
        }
      }
      if (b.parentId !== undefined) updates.parentId = nextParentId;
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
        const customer = await findProjectCustomer(req, cid, customerId, prev.customerId, nextProjectBranchId);
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

    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM companies WHERE id = ${cid} FOR UPDATE`);
      const [updated] = await tx.update(contractingProjectsTable)
        .set(updates)
        .where(and(eq(contractingProjectsTable.id, id), eq(contractingProjectsTable.companyId, cid)))
        .returning();
      return updated;
    });
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
    const [child] = await db.select({ id: contractingProjectsTable.id })
      .from(contractingProjectsTable)
      .where(and(
        eq(contractingProjectsTable.companyId, cid),
        eq(contractingProjectsTable.parentId, id),
      )).limit(1);
    if (child) {
      res.status(409).json({ error: "لا يمكن حذف مشروع أب قبل نقل أو حذف مشاريعه الفرعية" });
      return;
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
    res.json(await listExecutionWorkItems(cid, projectId));
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
    const row = await createExecutionWorkItem(cid, projectId, { ...b, category, status });
    await syncExecutionProjectProgress(cid, projectId);
    res.status(201).json(row);
  } catch (e: any) { res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" }); }
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
    const row = await updateExecutionWorkItem(cid, id, b);
    await syncExecutionProjectProgress(cid, row.projectId);

    res.json(row);
  } catch (e: any) { res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" }); }
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
    await syncExecutionProjectProgress(cid, current.projectId);
    res.json({ ok: true });
  } catch (e: any) {
    const isReferenced = e?.code === "23503";
    res.status(isReferenced ? 409 : 500).json({
      error: isReferenced ? "لا يمكن حذف بند مرتبط ببند WBS فرعي أو ببند عقد" : e?.message ?? "خطأ",
    });
  }
});

router.post("/projects/:projectId/work-items/:workItemId/resource-analysis", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const workItemId = Number(req.params.workItemId);
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    res.status(201).json(await upsertResourceAnalysis(cid, projectId, workItemId, req.body ?? {}));
  } catch (e: any) {
    const duplicate = e?.code === "23505";
    res.status(duplicate ? 409 : Number(e?.status) || 500).json({
      error: duplicate ? "هذا المورد مضاف بالفعل إلى تحليل البند" : e?.message ?? "خطأ",
    });
  }
});

router.put("/projects/:projectId/work-items/:workItemId/resource-analysis/:analysisId", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const workItemId = Number(req.params.workItemId);
    const analysisId = Number(req.params.analysisId);
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) {
      res.status(projectErrorStatus(projectError)).json({ error: projectError }); return;
    }
    res.json(await upsertResourceAnalysis(cid, projectId, workItemId, req.body ?? {}, analysisId));
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" });
  }
});

router.delete("/work-item-resource-analysis/:analysisId", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    await deleteResourceAnalysis(cid, Number(req.params.analysisId));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" });
  }
});

// ─────────────────── RESOURCES ───────────────────
// Inventory picker for material planning. It exposes only active stock items,
// their item-owned unit graph, and active warehouses visible to the project's
// branch (including company-wide warehouses).
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
    // A branchless project is visible only to company-wide/shared-project
    // callers.  It may use a company-wide warehouse safely, but exposing
    // branch-specific warehouses would let the picker infer a project branch
    // from an arbitrary selection.  Resource planning does not need stock
    // movement, so the shared option remains useful while mutations enforce
    // the same rule.
    warehouseConditions.push(project.branchId == null
      ? isNull(warehousesTable.branchId)
      : or(
          isNull(warehousesTable.branchId),
          eq(warehousesTable.branchId, project.branchId),
        ));
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
      requiresProjectBranch: project.branchId == null,
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
      ? or(isNull(warehousesTable.branchId), eq(warehousesTable.branchId, resourceProject.branchId))
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
    const userId = req.authUser!.id;
    const idempotencyKey = parseContractCreateIdempotencyKey(req);
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
    if (["active", "approved"].includes(String(b.status ?? "draft"))) {
      res.status(422).json({ error: "احفظ العقد كمسودة ثم أضف بند تنفيذ واحداً على الأقل واستخدم مسار الاعتماد" }); return;
    }
    const parentContractId = b.parentContractId == null || b.parentContractId === ""
      ? null : Number(b.parentContractId);
    if (["change_order", "addendum"].includes(contractType) && parentContractId == null) {
      res.status(400).json({ error: "أمر التغيير يجب أن يرتبط بعقد أساسي من نفس المشروع" }); return;
    }
    if (["approved", "rejected"].includes(String(b.status ?? "")) && ["change_order", "addendum"].includes(contractType)) {
      res.status(400).json({ error: "يجب استخدام مسار قرار أمر التغيير للاعتماد أو الرفض" }); return;
    }
    if (parentContractId != null) {
      if (contractType !== "change_order" && contractType !== "addendum") {
        res.status(400).json({ error: "العقد الأساسي يخصص لأمر تغيير أو ملحق فقط" }); return;
      }
      const parentError = await ensureOwnerContractParent(cid, projectId, parentContractId);
      if (parentError) { res.status(400).json({ error: parentError }); return; }
    }
    const value = Number(b.value ?? 0);
    const advancePct = Number(b.advancePercent ?? 0);
    const valueError = validateNonNegative(value, "قيمة العقد");
    const percentError = validatePercentage(advancePct, "نسبة الدفعة المقدمة");
    // Settings are copied into a new contract only. Later company policy
    // edits must never rewrite this contract's retention/recovery snapshot.
    const defaults = await getContractingSettings(cid);
    const recoveryEnabled = b.advanceRecoveryEnabled === undefined
      ? Boolean(defaults?.defaultAdvanceRecoveryEnabled)
      : b.advanceRecoveryEnabled === true;
    const recoveryPct = Number(
      b.advanceRecoveryPercent ?? defaults?.defaultAdvanceRecoveryPercent ?? 0,
    );
    const recoveryStartPct = Number(
      b.advanceRecoveryStartProgressPercent
      ?? b.startProgressPercent
      ?? defaults?.defaultAdvanceRecoveryStartProgressPercent
      ?? 0,
    );
    const recoveryMethod = String(b.advanceRecoveryMethod ?? "percentage");
    const recoveryFixedAmount = Number(b.advanceRecoveryFixedAmount ?? 0);
    const recoveryMethodError = validateAdvanceRecoveryMethod(recoveryMethod);
    const recoveryFixedError = validateNonNegative(recoveryFixedAmount, "قيمة استرداد السلفة الثابتة");
    const recoveryPercentError = validatePercentage(recoveryPct, "نسبة استرداد الدفعة المقدمة");
    const recoveryStartError = validatePercentage(recoveryStartPct, "بداية استرداد الدفعة المقدمة");
    const retentionEnabled = b.retentionEnabled == null
      ? defaults.defaultRetentionEnabled !== false
      : b.retentionEnabled === true;
    const retentionPct = Number(b.retentionPercent ?? defaults.defaultRetentionPercent ?? 5);
    const retentionCapPct = Number(b.retentionCapPercent ?? defaults.defaultRetentionCapPercent ?? 100);
    const retentionPercentError = validatePercentage(retentionPct, "نسبة المحتجزات");
    const retentionCapError = validatePercentage(retentionCapPct, "سقف المحتجزات");
    const advancePay = b.advancePayment !== undefined ? Number(b.advancePayment) : calculateAdvancePayment(value, advancePct);
    const advanceError = validateNonNegative(advancePay, "الدفعة المقدمة");
    if (valueError || percentError || recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError || retentionPercentError || retentionCapError || advanceError) {
      res.status(400).json({ error: valueError || percentError || recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError || retentionPercentError || retentionCapError || advanceError }); return;
    }
    const values = {
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
      advanceRecoveryEnabled: recoveryEnabled,
      advanceRecoveryPercent: String(recoveryPct),
      advanceRecoveryMethod: recoveryMethod,
      advanceRecoveryFixedAmount: String(recoveryFixedAmount),
      advanceRecoveryStartProgressPercent: String(recoveryStartPct),
      retentionEnabled,
      retentionPercent: String(retentionPct),
      retentionCapPercent: String(retentionCapPct),
      vatPercent:       String(b.vatPercent ?? 15),
      durationDays: Number(b.durationDays ?? 0),
      startDate: b.startDate ?? null,
      endDate:   b.endDate   ?? null,
      paymentTerms: b.paymentTerms ?? null,
      scopeOfWork:  b.scopeOfWork  ?? null,
      penaltiesClause: b.penaltiesClause ?? null,
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    };
    const payloadHash = contractCreateFingerprint({
      operation: "owner_contract_create",
      userId,
      ...values,
    });
    const createResult = await createContractIdempotently({
      companyId: cid,
      userId,
      operation: "owner_contract_create",
      idempotencyKey,
      payloadHash,
      create: async (tx) => {
        const [row] = await tx.insert(contractingOwnerContractsTable).values(values).returning();
        if (!row) throw new Error("تعذر إنشاء عقد المالك");
        return row;
      },
    });
    if (!createResult.created) {
      res.status(200).json({ ...createResult.result, idempotentReplay: true });
      return;
    }
    const row = createResult.row;
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "owner_contract_created",
      title: `عقد مالك جديد رقم ${row.contractNumber}`,
      description: `قيمة العقد: ${row.value} ر.س`,
    });
    res.status(201).json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" });
  }
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
    if (["change_order", "addendum"].includes(String(b.contractType ?? cur.contractType))
      && ["approved", "rejected"].includes(String(b.status ?? ""))) {
      res.status(409).json({ error: "استخدم مسار قرار أمر التغيير لتسجيل الاعتماد أو الرفض" }); return;
    }
    if (["active", "approved"].includes(String(b.status ?? ""))
      && String(b.status) !== String(cur.status)) {
      res.status(422).json({ error: "استخدم مسار اعتماد العقد بعد إضافة بند تنفيذ واحد على الأقل" }); return;
    }
    const upd: any = { updatedAt: new Date() };
    let nextProjectId = Number(cur.projectId);
    if (b.projectId !== undefined) {
      const requestedProjectId = Number(b.projectId);
      if (!Number.isInteger(requestedProjectId) || requestedProjectId <= 0) {
        res.status(400).json({ error: "المشروع غير صالح" }); return;
      }
      const moveError = await contractProjectMoveError(
        cid,
        id,
        "owner",
        Number(cur.projectId),
        requestedProjectId,
        req,
      );
      if (moveError) {
        res.status(moveError === "ليس لديك صلاحية هذا الفرع" ? 403 : 409).json({ error: moveError });
        return;
      }
      nextProjectId = requestedProjectId;
      upd.projectId = requestedProjectId;
    }
    for (const k of ["contractNumber","contractType","status","clientName","paymentTerms","scopeOfWork","penaltiesClause","notes"]) {
      if (b[k] !== undefined) upd[k] = b[k];
    }
    if (b.parentContractId !== undefined) {
      const parentContractId = b.parentContractId == null || b.parentContractId === ""
        ? null : Number(b.parentContractId);
      const contractType = String(b.contractType ?? cur.contractType);
      const nextProjectId = b.projectId !== undefined ? Number(b.projectId) : Number(cur.projectId);
      if (parentContractId != null) {
        if (contractType !== "change_order" && contractType !== "addendum") {
          res.status(400).json({ error: "العقد الأساسي يخصص لأمر تغيير أو ملحق فقط" }); return;
        }
        const parentError = await ensureOwnerContractParent(cid, nextProjectId, parentContractId, id);
        if (parentError) { res.status(400).json({ error: parentError }); return; }
      } else if (["change_order", "addendum"].includes(contractType)) {
        res.status(400).json({ error: "أمر التغيير يجب أن يرتبط بعقد أساسي من نفس المشروع" }); return;
      }
      upd.parentContractId = parentContractId;
    } else if (["change_order", "addendum"].includes(String(b.contractType ?? cur.contractType))
      && cur.parentContractId == null) {
      res.status(400).json({ error: "أمر التغيير يجب أن يرتبط بعقد أساسي من نفس المشروع" }); return;
    } else if (b.contractType !== undefined && !["change_order", "addendum"].includes(String(b.contractType))) {
      upd.parentContractId = null;
    } else if (b.projectId !== undefined && cur.parentContractId != null) {
      const parentError = await ensureOwnerContractParent(cid, nextProjectId, Number(cur.parentContractId), id);
      if (parentError) { res.status(409).json({ error: parentError }); return; }
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
    const valueChanged = b.value !== undefined;
    const advancePercentChanged = b.advancePercent !== undefined;
    const value = valueChanged ? Number(b.value) : Number(cur.value);
    const advancePct = advancePercentChanged ? Number(b.advancePercent) : Number(cur.advancePercent);
    if (valueChanged) {
      const error = validateNonNegative(value, "قيمة العقد");
      if (error) { res.status(400).json({ error }); return; }
      upd.value = String(value);
    }
    if (advancePercentChanged) {
      const error = validatePercentage(advancePct, "نسبة الدفعة المقدمة");
      if (error) { res.status(400).json({ error }); return; }
      upd.advancePercent = String(advancePct);
    }
    const recoveryEnabledChanged = b.advanceRecoveryEnabled !== undefined;
    const recoveryPercentChanged = b.advanceRecoveryPercent !== undefined;
    const recoveryStartChanged = b.advanceRecoveryStartProgressPercent !== undefined || b.startProgressPercent !== undefined;
    const recoveryPct = recoveryPercentChanged
      ? Number(b.advanceRecoveryPercent)
      : Number(cur.advanceRecoveryPercent ?? 0);
    const recoveryStartPct = recoveryStartChanged
      ? Number(b.advanceRecoveryStartProgressPercent ?? b.startProgressPercent)
      : Number(cur.advanceRecoveryStartProgressPercent ?? 0);
    const recoveryMethodChanged = b.advanceRecoveryMethod !== undefined;
    const recoveryFixedChanged = b.advanceRecoveryFixedAmount !== undefined;
    const recoveryMethod = recoveryMethodChanged
      ? String(b.advanceRecoveryMethod)
      : String(cur.advanceRecoveryMethod ?? "percentage");
    const recoveryFixedAmount = recoveryFixedChanged
      ? Number(b.advanceRecoveryFixedAmount)
      : Number(cur.advanceRecoveryFixedAmount ?? 0);
    const recoveryMethodError = validateAdvanceRecoveryMethod(recoveryMethod);
    const recoveryFixedError = validateNonNegative(recoveryFixedAmount, "قيمة استرداد السلفة الثابتة");
    const recoveryPercentError = validatePercentage(recoveryPct, "نسبة استرداد الدفعة المقدمة");
    const recoveryStartError = validatePercentage(recoveryStartPct, "بداية استرداد الدفعة المقدمة");
    if (recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError) {
      res.status(400).json({ error: recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError }); return;
    }
    if (recoveryEnabledChanged) upd.advanceRecoveryEnabled = b.advanceRecoveryEnabled === true;
    if (recoveryPercentChanged) upd.advanceRecoveryPercent = String(recoveryPct);
    if (recoveryMethodChanged) upd.advanceRecoveryMethod = recoveryMethod;
    if (recoveryFixedChanged) upd.advanceRecoveryFixedAmount = String(recoveryFixedAmount);
    if (recoveryStartChanged) upd.advanceRecoveryStartProgressPercent = String(recoveryStartPct);
    // A legacy form may submit the stored amount alongside a changed value or
    // percentage. Recalculate in that case; otherwise an amount-only edit
    // remains the explicit value entered by the user.
    const contractInputsChanged =
      (valueChanged && value !== Number(cur.value)) ||
      (advancePercentChanged && advancePct !== Number(cur.advancePercent));
    if (contractInputsChanged) {
      upd.advancePayment = String(calculateAdvancePayment(value, advancePct));
    } else if (b.advancePayment !== undefined) {
      const advancePay = Number(b.advancePayment);
      const error = validateNonNegative(advancePay, "الدفعة المقدمة");
      if (error) { res.status(400).json({ error }); return; }
      upd.advancePayment = String(advancePay);
    }
    const retentionEnabledChanged = b.retentionEnabled !== undefined && b.retentionEnabled !== null;
    const retentionPercentChanged = b.retentionPercent !== undefined && b.retentionPercent !== null;
    const retentionCapChanged = b.retentionCapPercent !== undefined && b.retentionCapPercent !== null;
    const retentionPct = retentionPercentChanged
      ? Number(b.retentionPercent)
      : Number(cur.retentionPercent ?? 5);
    const retentionCapPct = retentionCapChanged
      ? Number(b.retentionCapPercent)
      : Number(cur.retentionCapPercent ?? 100);
    const retentionPercentError = validatePercentage(retentionPct, "نسبة المحتجزات");
    const retentionCapError = validatePercentage(retentionCapPct, "سقف المحتجزات");
    if (retentionPercentError || retentionCapError) {
      res.status(400).json({ error: retentionPercentError || retentionCapError }); return;
    }
    if (retentionEnabledChanged) upd.retentionEnabled = b.retentionEnabled === true;
    if (retentionPercentChanged) upd.retentionPercent = String(retentionPct);
    if (retentionCapChanged) upd.retentionCapPercent = String(retentionCapPct);
    if (b.vatPercent !== undefined) upd.vatPercent = String(b.vatPercent);
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: contractingOwnerContractsTable.id })
        .from(contractingOwnerContractsTable)
        .where(and(eq(contractingOwnerContractsTable.id, id), eq(contractingOwnerContractsTable.companyId, cid)))
        .for("update");
      if (!locked) throw Object.assign(new Error("غير موجود"), { status: 404 });
      const [updated] = await tx.update(contractingOwnerContractsTable).set(upd)
        .where(and(eq(contractingOwnerContractsTable.id, id), eq(contractingOwnerContractsTable.companyId, cid)))
        .returning();
      return updated;
    });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/owner-contracts/:id/change-order-decision", requirePermission("contracting", "approve"), async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const decision = String(req.body?.decision ?? req.body?.status ?? "");
    if (!["approved", "rejected"].includes(decision)) {
      res.status(400).json({ error: "قرار أمر التغيير يجب أن يكون اعتماداً أو رفضاً" }); return;
    }
    const [cur] = await db.select().from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.id, id),
      eq(contractingOwnerContractsTable.companyId, cid),
    ));
    if (!cur) { res.status(404).json({ error: "أمر التغيير غير موجود" }); return; }
    const projectError = await ensureProject(cid, cur.projectId, req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    if (!["change_order", "addendum"].includes(String(cur.contractType))) {
      res.status(400).json({ error: "العقد المحدد ليس أمراً تغييرياً أو ملحقاً" }); return;
    }
    if (decision === "approved" && !cur.signedAt) {
      res.status(422).json({ error: "لا يمكن اعتماد أمر تغيير غير موقع" }); return;
    }
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(contractingOwnerContractsTable)
        .where(and(
          eq(contractingOwnerContractsTable.id, id),
          eq(contractingOwnerContractsTable.companyId, cid),
        ))
        .for("update");
      if (!locked) throw Object.assign(new Error("أمر التغيير غير موجود"), { status: 404 });
      if (decision === "approved") {
        if (await contractBoqLineCount(cid, locked.projectId, "owner", id, tx) < 1) {
          throw Object.assign(new Error("لا يمكن اعتماد العقد قبل إضافة بند تنفيذ واحد على الأقل."), { status: 422 });
        }
        await assertChangeOrderReductionSafe(cid, locked.projectId, id, "owner", tx);
      }
      const [updated] = await tx.update(contractingOwnerContractsTable).set({
        status: decision,
        updatedAt: new Date(),
      }).where(and(
        eq(contractingOwnerContractsTable.id, id),
        eq(contractingOwnerContractsTable.companyId, cid),
      )).returning();
      return updated;
    });
    await logEvent({
      companyId: cid,
      projectId: cur.projectId,
      userId: req.authUser?.id,
      eventType: `owner_change_order_${decision}`,
      title: `${decision === "approved" ? "اعتماد" : "رفض"} أمر تغيير المالك ${cur.contractNumber}`,
      description: req.body?.reason ? String(req.body.reason) : null,
      meta: { contractId: id, decision },
    });
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" });
  }
});

router.put("/owner-contracts/:id/approve", requirePermission("contracting", "approve"), async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const row = await db.transaction(async (tx) => {
      const [contract] = await tx.select().from(contractingOwnerContractsTable).where(and(
        eq(contractingOwnerContractsTable.id, id),
        eq(contractingOwnerContractsTable.companyId, cid),
      )).for("update");
      if (!contract) throw Object.assign(new Error("العقد غير موجود"), { status: 404 });
      const projectError = await ensureProject(cid, contract.projectId, req);
      if (projectError) throw Object.assign(new Error(projectError), { status: projectErrorStatus(projectError) });
      if (contract.contractType !== "main") {
        throw Object.assign(new Error("اعتماد أوامر التغيير يتم من مسار قرار أمر التغيير"), { status: 409 });
      }
      if (await contractBoqLineCount(cid, contract.projectId, "owner", id, tx) < 1) {
        throw Object.assign(new Error("لا يمكن اعتماد العقد قبل إضافة بند تنفيذ واحد على الأقل."), { status: 422 });
      }
      const [updated] = await tx.update(contractingOwnerContractsTable).set({
        status: "approved",
        updatedAt: new Date(),
      }).where(and(
        eq(contractingOwnerContractsTable.id, id),
        eq(contractingOwnerContractsTable.companyId, cid),
      )).returning();
      return updated;
    });
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر اعتماد العقد" });
  }
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
    const userId = req.authUser!.id;
    const idempotencyKey = parseContractCreateIdempotencyKey(req);
    if (!b?.contractNumber || !b?.contractDate || !b?.contractorId) {
      res.status(400).json({ error: "رقم العقد، التاريخ، والمقاول الباطن مطلوبة" }); return;
    }
    const projErr = await ensureProject(cid, projectId, req);
    if (projErr) { res.status(projectErrorStatus(projErr)).json({ error: projErr }); return; }
    const conErr  = await ensureContractor(cid, Number(b.contractorId));
    if (conErr)  { res.status(400).json({ error: conErr }); return; }
    const contractType = String(b.contractType ?? "main");
    if (["active", "approved"].includes(String(b.status ?? "draft"))) {
      res.status(422).json({ error: "احفظ العقد كمسودة ثم أضف بند تنفيذ واحداً على الأقل واستخدم مسار الاعتماد" }); return;
    }
    const parentContractId = b.parentContractId == null || b.parentContractId === ""
      ? null : Number(b.parentContractId);
    if (!["main", "change_order"].includes(contractType)) {
      res.status(400).json({ error: "نوع عقد الباطن غير صالح" }); return;
    }
    if (contractType === "change_order" && parentContractId == null) {
      res.status(400).json({ error: "أمر تغيير الباطن يجب أن يرتبط بعقد أساسي من نفس المشروع" }); return;
    }
    if (["approved", "rejected"].includes(String(b.status ?? "")) && contractType === "change_order") {
      res.status(400).json({ error: "يجب استخدام مسار قرار أمر تغيير الباطن للاعتماد أو الرفض" }); return;
    }
    if (parentContractId != null) {
      if (contractType !== "change_order") {
        res.status(400).json({ error: "العقد الأساسي مخصص لأمر تغيير الباطن فقط" }); return;
      }
      const parentError = await ensureSubContractParent(cid, projectId, parentContractId);
      if (parentError) { res.status(400).json({ error: parentError }); return; }
    }
    const value = Number(b.value ?? 0);
    const advancePct = Number(b.advancePercent ?? 0);
    const valueError = validateNonNegative(value, "قيمة العقد");
    const percentError = validatePercentage(advancePct, "نسبة الدفعة المقدمة");
    // Company policy is a source for new-contract snapshots only.
    const defaults = await getContractingSettings(cid);
    const recoveryEnabled = b.advanceRecoveryEnabled === undefined
      ? Boolean(defaults?.defaultAdvanceRecoveryEnabled)
      : b.advanceRecoveryEnabled === true;
    const recoveryPct = Number(
      b.advanceRecoveryPercent ?? defaults?.defaultAdvanceRecoveryPercent ?? 0,
    );
    const recoveryStartPct = Number(
      b.advanceRecoveryStartProgressPercent
      ?? b.startProgressPercent
      ?? defaults?.defaultAdvanceRecoveryStartProgressPercent
      ?? 0,
    );
    const recoveryMethod = String(b.advanceRecoveryMethod ?? "percentage");
    const recoveryFixedAmount = Number(b.advanceRecoveryFixedAmount ?? 0);
    const recoveryMethodError = validateAdvanceRecoveryMethod(recoveryMethod);
    const recoveryFixedError = validateNonNegative(recoveryFixedAmount, "قيمة استرداد السلفة الثابتة");
    const recoveryPercentError = validatePercentage(recoveryPct, "نسبة استرداد الدفعة المقدمة");
    const recoveryStartError = validatePercentage(recoveryStartPct, "بداية استرداد الدفعة المقدمة");
    const retentionEnabled = b.retentionEnabled == null
      ? defaults.defaultRetentionEnabled !== false
      : b.retentionEnabled === true;
    const retentionPct = Number(b.retentionPercent ?? defaults.defaultRetentionPercent ?? 5);
    const retentionCapPct = Number(b.retentionCapPercent ?? defaults.defaultRetentionCapPercent ?? 100);
    const retentionPercentError = validatePercentage(retentionPct, "نسبة المحتجزات");
    const retentionCapError = validatePercentage(retentionCapPct, "سقف المحتجزات");
    const advancePay = b.advancePayment !== undefined ? Number(b.advancePayment) : calculateAdvancePayment(value, advancePct);
    const advanceError = validateNonNegative(advancePay, "الدفعة المقدمة");
    if (valueError || percentError || recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError || retentionPercentError || retentionCapError || advanceError) {
      res.status(400).json({ error: valueError || percentError || recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError || retentionPercentError || retentionCapError || advanceError }); return;
    }
    const values = {
      companyId: cid, projectId,
      contractorId: Number(b.contractorId),
      contractNumber: String(b.contractNumber),
      contractDate: b.contractDate,
      signedAt: b.signedAt ?? null,
      contractType,
      parentContractId,
      scopeOfWork: b.scopeOfWork ?? null,
      value:            String(value),
      advancePayment:   String(advancePay),
      advancePercent:   String(advancePct),
      advanceRecoveryEnabled: recoveryEnabled,
      advanceRecoveryPercent: String(recoveryPct),
      advanceRecoveryMethod: recoveryMethod,
      advanceRecoveryFixedAmount: String(recoveryFixedAmount),
      advanceRecoveryStartProgressPercent: String(recoveryStartPct),
      retentionEnabled,
      retentionPercent: String(retentionPct),
      retentionCapPercent: String(retentionCapPct),
      vatPercent:       String(b.vatPercent ?? 15),
      durationDays: Number(b.durationDays ?? 0),
      startDate: b.startDate ?? null,
      endDate:   b.endDate   ?? null,
      paymentTerms: b.paymentTerms ?? null,
      penaltiesClause: b.penaltiesClause ?? null,
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    };
    const payloadHash = contractCreateFingerprint({
      operation: "subcontract_create",
      userId,
      ...values,
    });
    const createResult = await createContractIdempotently({
      companyId: cid,
      userId,
      operation: "subcontract_create",
      idempotencyKey,
      payloadHash,
      create: async (tx) => {
        const [row] = await tx.insert(contractingSubContractsTable).values(values).returning();
        if (!row) throw new Error("تعذر إنشاء عقد الباطن");
        return row;
      },
    });
    if (!createResult.created) {
      res.status(200).json({ ...createResult.result, idempotentReplay: true });
      return;
    }
    const row = createResult.row;
    await logEvent({
      companyId: cid, projectId, userId: req.authUser!.id,
      eventType: "sub_contract_created",
      title: `عقد مقاول باطن جديد رقم ${row.contractNumber}`,
      description: `قيمة العقد: ${row.value} ر.س`,
    });
    res.status(201).json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" });
  }
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
    if (String(b.contractType ?? cur.contractType) === "change_order"
      && ["approved", "rejected"].includes(String(b.status ?? ""))) {
      res.status(409).json({ error: "استخدم مسار قرار أمر تغيير الباطن لتسجيل الاعتماد أو الرفض" }); return;
    }
    if (["active", "approved"].includes(String(b.status ?? ""))
      && String(b.status) !== String(cur.status)) {
      res.status(422).json({ error: "استخدم مسار اعتماد العقد بعد إضافة بند تنفيذ واحد على الأقل" }); return;
    }
    const upd: any = { updatedAt: new Date() };
    let nextProjectId = Number(cur.projectId);
    if (b.projectId !== undefined) {
      const requestedProjectId = Number(b.projectId);
      if (!Number.isInteger(requestedProjectId) || requestedProjectId <= 0) {
        res.status(400).json({ error: "المشروع غير صالح" }); return;
      }
      const moveError = await contractProjectMoveError(
        cid,
        id,
        "subcontract",
        Number(cur.projectId),
        requestedProjectId,
        req,
      );
      if (moveError) {
        res.status(moveError === "ليس لديك صلاحية هذا الفرع" ? 403 : 409).json({ error: moveError });
        return;
      }
      nextProjectId = requestedProjectId;
      upd.projectId = requestedProjectId;
    }
    for (const k of ["contractNumber","status","scopeOfWork","paymentTerms","penaltiesClause","notes","contractType"]) {
      if (b[k] !== undefined) upd[k] = b[k];
    }
    if (b.contractType !== undefined && !["main", "change_order"].includes(String(b.contractType))) {
      res.status(400).json({ error: "نوع عقد الباطن غير صالح" }); return;
    }
    if (b.parentContractId !== undefined) {
      const parentContractId = b.parentContractId == null || b.parentContractId === ""
        ? null : Number(b.parentContractId);
      const contractType = String(b.contractType ?? cur.contractType);
      if (parentContractId != null) {
        if (contractType !== "change_order") {
          res.status(400).json({ error: "العقد الأساسي مخصص لأمر تغيير الباطن فقط" }); return;
        }
        const parentError = await ensureSubContractParent(cid, nextProjectId, parentContractId, id);
        if (parentError) { res.status(400).json({ error: parentError }); return; }
      } else if (contractType === "change_order") {
        res.status(400).json({ error: "أمر تغيير الباطن يجب أن يرتبط بعقد أساسي من نفس المشروع" }); return;
      }
      upd.parentContractId = parentContractId;
    } else if (String(b.contractType ?? cur.contractType) === "change_order" && cur.parentContractId == null) {
      res.status(400).json({ error: "أمر تغيير الباطن يجب أن يرتبط بعقد أساسي من نفس المشروع" }); return;
    } else if (b.contractType !== undefined && b.contractType !== "change_order") {
      upd.parentContractId = null;
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
    const valueChanged = b.value !== undefined;
    const advancePercentChanged = b.advancePercent !== undefined;
    const value = valueChanged ? Number(b.value) : Number(cur.value);
    const advancePct = advancePercentChanged ? Number(b.advancePercent) : Number(cur.advancePercent);
    if (valueChanged) {
      const error = validateNonNegative(value, "قيمة العقد");
      if (error) { res.status(400).json({ error }); return; }
      upd.value = String(value);
    }
    if (advancePercentChanged) {
      const error = validatePercentage(advancePct, "نسبة الدفعة المقدمة");
      if (error) { res.status(400).json({ error }); return; }
      upd.advancePercent = String(advancePct);
    }
    // A legacy form may submit the stored amount alongside a changed value or
    // percentage. Recalculate in that case; otherwise an amount-only edit
    // remains the explicit value entered by the user.
    const contractInputsChanged =
      (valueChanged && value !== Number(cur.value)) ||
      (advancePercentChanged && advancePct !== Number(cur.advancePercent));
    if (contractInputsChanged) {
      upd.advancePayment = String(calculateAdvancePayment(value, advancePct));
    } else if (b.advancePayment !== undefined) {
      const advancePay = Number(b.advancePayment);
      const error = validateNonNegative(advancePay, "الدفعة المقدمة");
      if (error) { res.status(400).json({ error }); return; }
      upd.advancePayment = String(advancePay);
    }
    const retentionEnabledChanged = b.retentionEnabled !== undefined && b.retentionEnabled !== null;
    const retentionPercentChanged = b.retentionPercent !== undefined && b.retentionPercent !== null;
    const retentionCapChanged = b.retentionCapPercent !== undefined && b.retentionCapPercent !== null;
    const retentionPct = retentionPercentChanged
      ? Number(b.retentionPercent)
      : Number(cur.retentionPercent ?? 5);
    const retentionCapPct = retentionCapChanged
      ? Number(b.retentionCapPercent)
      : Number(cur.retentionCapPercent ?? 100);
    const retentionPercentError = validatePercentage(retentionPct, "نسبة المحتجزات");
    const retentionCapError = validatePercentage(retentionCapPct, "سقف المحتجزات");
    if (retentionPercentError || retentionCapError) {
      res.status(400).json({ error: retentionPercentError || retentionCapError }); return;
    }
    if (retentionEnabledChanged) upd.retentionEnabled = b.retentionEnabled === true;
    if (retentionPercentChanged) upd.retentionPercent = String(retentionPct);
    if (retentionCapChanged) upd.retentionCapPercent = String(retentionCapPct);
    if (b.vatPercent !== undefined) upd.vatPercent = String(b.vatPercent);
    const recoveryEnabledChanged = b.advanceRecoveryEnabled !== undefined;
    const recoveryPercentChanged = b.advanceRecoveryPercent !== undefined;
    const recoveryStartChanged = b.advanceRecoveryStartProgressPercent !== undefined || b.startProgressPercent !== undefined;
    const recoveryPct = recoveryPercentChanged
      ? Number(b.advanceRecoveryPercent)
      : Number(cur.advanceRecoveryPercent ?? 0);
    const recoveryStartPct = recoveryStartChanged
      ? Number(b.advanceRecoveryStartProgressPercent ?? b.startProgressPercent)
      : Number(cur.advanceRecoveryStartProgressPercent ?? 0);
    const recoveryMethodChanged = b.advanceRecoveryMethod !== undefined;
    const recoveryFixedChanged = b.advanceRecoveryFixedAmount !== undefined;
    const recoveryMethod = recoveryMethodChanged
      ? String(b.advanceRecoveryMethod)
      : String(cur.advanceRecoveryMethod ?? "percentage");
    const recoveryFixedAmount = recoveryFixedChanged
      ? Number(b.advanceRecoveryFixedAmount)
      : Number(cur.advanceRecoveryFixedAmount ?? 0);
    const recoveryMethodError = validateAdvanceRecoveryMethod(recoveryMethod);
    const recoveryFixedError = validateNonNegative(recoveryFixedAmount, "قيمة استرداد السلفة الثابتة");
    const recoveryPercentError = validatePercentage(recoveryPct, "نسبة استرداد الدفعة المقدمة");
    const recoveryStartError = validatePercentage(recoveryStartPct, "بداية استرداد الدفعة المقدمة");
    if (recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError) {
      res.status(400).json({ error: recoveryPercentError || recoveryStartError || recoveryMethodError || recoveryFixedError }); return;
    }
    if (recoveryEnabledChanged) upd.advanceRecoveryEnabled = b.advanceRecoveryEnabled === true;
    if (recoveryPercentChanged) upd.advanceRecoveryPercent = String(recoveryPct);
    if (recoveryMethodChanged) upd.advanceRecoveryMethod = recoveryMethod;
    if (recoveryFixedChanged) upd.advanceRecoveryFixedAmount = String(recoveryFixedAmount);
    if (recoveryStartChanged) upd.advanceRecoveryStartProgressPercent = String(recoveryStartPct);
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: contractingSubContractsTable.id })
        .from(contractingSubContractsTable)
        .where(and(eq(contractingSubContractsTable.id, id), eq(contractingSubContractsTable.companyId, cid)))
        .for("update");
      if (!locked) throw Object.assign(new Error("غير موجود"), { status: 404 });
      const [updated] = await tx.update(contractingSubContractsTable).set(upd)
        .where(and(eq(contractingSubContractsTable.id, id), eq(contractingSubContractsTable.companyId, cid)))
        .returning();
      return updated;
    });
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/sub-contracts/:id/change-order-decision", requirePermission("contracting", "approve"), async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const decision = String(req.body?.decision ?? req.body?.status ?? "");
    if (!["approved", "rejected"].includes(decision)) {
      res.status(400).json({ error: "قرار أمر تغيير الباطن يجب أن يكون اعتماداً أو رفضاً" }); return;
    }
    const [cur] = await db.select().from(contractingSubContractsTable).where(and(
      eq(contractingSubContractsTable.id, id),
      eq(contractingSubContractsTable.companyId, cid),
    ));
    if (!cur) { res.status(404).json({ error: "أمر تغيير الباطن غير موجود" }); return; }
    const projectError = await ensureProject(cid, cur.projectId, req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    if (cur.contractType !== "change_order") {
      res.status(400).json({ error: "العقد المحدد ليس أمر تغيير باطن" }); return;
    }
    if (decision === "approved" && !cur.signedAt) {
      res.status(422).json({ error: "لا يمكن اعتماد أمر تغيير غير موقع" }); return;
    }
    const row = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(contractingSubContractsTable)
        .where(and(
          eq(contractingSubContractsTable.id, id),
          eq(contractingSubContractsTable.companyId, cid),
        ))
        .for("update");
      if (!locked) throw Object.assign(new Error("أمر تغيير الباطن غير موجود"), { status: 404 });
      if (decision === "approved") {
        if (await contractBoqLineCount(cid, locked.projectId, "subcontract", id, tx) < 1) {
          throw Object.assign(new Error("لا يمكن اعتماد العقد قبل إضافة بند تنفيذ واحد على الأقل."), { status: 422 });
        }
        await assertChangeOrderReductionSafe(cid, locked.projectId, id, "subcontract", tx);
      }
      const [updated] = await tx.update(contractingSubContractsTable).set({
        status: decision,
        updatedAt: new Date(),
      }).where(and(
        eq(contractingSubContractsTable.id, id),
        eq(contractingSubContractsTable.companyId, cid),
      )).returning();
      return updated;
    });
    await logEvent({
      companyId: cid,
      projectId: cur.projectId,
      userId: req.authUser?.id,
      eventType: `subcontract_change_order_${decision}`,
      title: `${decision === "approved" ? "اعتماد" : "رفض"} أمر تغيير الباطن ${cur.contractNumber}`,
      description: req.body?.reason ? String(req.body.reason) : null,
      meta: { contractId: id, decision },
    });
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" });
  }
});

router.put("/sub-contracts/:id/approve", requirePermission("contracting", "approve"), async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const row = await db.transaction(async (tx) => {
      const [contract] = await tx.select().from(contractingSubContractsTable).where(and(
        eq(contractingSubContractsTable.id, id),
        eq(contractingSubContractsTable.companyId, cid),
      )).for("update");
      if (!contract) throw Object.assign(new Error("العقد غير موجود"), { status: 404 });
      const projectError = await ensureProject(cid, contract.projectId, req);
      if (projectError) throw Object.assign(new Error(projectError), { status: projectErrorStatus(projectError) });
      if (contract.contractType !== "main") {
        throw Object.assign(new Error("اعتماد أوامر التغيير يتم من مسار قرار أمر التغيير"), { status: 409 });
      }
      if (await contractBoqLineCount(cid, contract.projectId, "subcontract", id, tx) < 1) {
        throw Object.assign(new Error("لا يمكن اعتماد العقد قبل إضافة بند تنفيذ واحد على الأقل."), { status: 422 });
      }
      const [updated] = await tx.update(contractingSubContractsTable).set({
        status: "approved",
        updatedAt: new Date(),
      }).where(and(
        eq(contractingSubContractsTable.id, id),
        eq(contractingSubContractsTable.companyId, cid),
      )).returning();
      return updated;
    });
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر اعتماد العقد" });
  }
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

// ─────────────────── TENDERS + BANK GUARANTEES ───────────────────
// Initial guarantees belong to a tender/project and intentionally have no
// contract. Awarding selects an existing contract. A resulting performance
// guarantee is always a new child row; the initial row is never converted.
const TENDER_STATUSES = new Set(["draft", "submitted", "under_review", "awarded", "lost", "cancelled"]);
const GUARANTEE_TYPES = new Set(["initial", "performance", "advance_payment", "maintenance", "other"]);
const GUARANTEE_STATUSES = new Set(["draft", "issued", "active", "extended", "released", "expired", "cancelled"]);
const GUARANTEE_TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["issued", "cancelled"]),
  issued: new Set(["active", "cancelled"]),
  active: new Set(["extended", "released", "expired", "cancelled"]),
  extended: new Set(["active", "released", "expired", "cancelled"]),
  expired: new Set(["released"]),
  released: new Set(),
  cancelled: new Set(),
};

function resultRows(result: any): any[] {
  return Array.isArray(result) ? result : result?.rows ?? [];
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function ensureGuaranteeBank(cid: number, id: number): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM bank_accounts
     WHERE id = ${id} AND company_id = ${cid} AND is_active = true
     LIMIT 1
  `);
  return resultRows(result).length ? null : "الحساب البنكي غير صالح أو غير نشط";
}

async function ensureGuaranteeCustomer(cid: number, id: number): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM customers WHERE id = ${id} AND company_id = ${cid} LIMIT 1
  `);
  return resultRows(result).length ? null : "المستفيد غير صالح أو يتبع شركة أخرى";
}

async function guaranteeRelationship(
  cid: number,
  projectId: number,
  body: any,
): Promise<{ tenderId: number | null; contractKind: string | null; ownerContractId: number | null; subcontractId: number | null; parentGuaranteeId: number | null } | string> {
  const guaranteeType = String(body.guaranteeType ?? "");
  let tenderId = positiveId(body.tenderId);
  const contractKind = body.contractKind == null || body.contractKind === "" ? null : String(body.contractKind);
  const ownerContractId = contractKind === "owner" ? positiveId(body.ownerContractId ?? body.contractId) : null;
  const subcontractId = contractKind === "subcontract" ? positiveId(body.subcontractId ?? body.contractId) : null;
  const parentGuaranteeId = positiveId(body.parentGuaranteeId);

  if (guaranteeType === "initial") {
    if (!tenderId || contractKind || ownerContractId || subcontractId || parentGuaranteeId) {
      return "الضمان الابتدائي يرتبط بالمناقصة والمشروع فقط ولا يرتبط بعقد أو ضمان أب";
    }
  } else if (
    !["owner", "subcontract"].includes(String(contractKind))
    || (contractKind === "owner" ? !ownerContractId : !subcontractId)
  ) {
    return "الضمان بعد الترسية يجب أن يرتبط بعقد مالك أو عقد باطن محدد داخل المشروع";
  }

  if (tenderId) {
    const tender = resultRows(await db.execute(sql`
      SELECT id, status FROM contracting_tenders
       WHERE id = ${tenderId} AND company_id = ${cid} AND project_id = ${projectId}
         AND archived_at IS NULL
       LIMIT 1
    `))[0];
    if (!tender) return "المناقصة لا تتبع المشروع والشركة المحددين";
    if (guaranteeType === "initial" && !["draft", "submitted", "under_review"].includes(String(tender.status))) {
      return "لا يمكن إصدار ضمان ابتدائي لمناقصة تمت ترسيتها أو إغلاقها";
    }
  }
  if (ownerContractId) {
    const error = await ensureOwnerContract(cid, projectId, ownerContractId);
    if (error) return error;
  }
  if (subcontractId) {
    const error = await ensureSubContract(cid, projectId, subcontractId);
    if (error) return error;
  }
  if (parentGuaranteeId) {
    if (guaranteeType !== "performance") return "الضمان الأب يستخدم فقط للضمان النهائي الناتج عن ضمان ابتدائي";
    const parent = resultRows(await db.execute(sql`
      SELECT g.id, g.tender_id, t.status AS tender_status,
             t.awarded_contract_kind, t.awarded_owner_contract_id, t.awarded_subcontract_id
        FROM contracting_guarantees g
        JOIN contracting_tenders t ON t.id = g.tender_id AND t.company_id = g.company_id
       WHERE g.id = ${parentGuaranteeId} AND g.company_id = ${cid} AND g.project_id = ${projectId}
         AND g.guarantee_type = 'initial' AND g.archived_at IS NULL AND t.archived_at IS NULL
       LIMIT 1
    `))[0];
    if (!parent) return "الضمان الابتدائي الأب غير صالح";
    if (parent.tender_status !== "awarded") return "لا يمكن إنشاء الضمان النهائي قبل ترسية مناقصة الضمان الابتدائي";
    if (String(parent.awarded_contract_kind) !== contractKind
      || (contractKind === "owner" && Number(parent.awarded_owner_contract_id) !== ownerContractId)
      || (contractKind === "subcontract" && Number(parent.awarded_subcontract_id) !== subcontractId)) {
      return "العقد المحدد لا يطابق العقد الذي رست عليه مناقصة الضمان الابتدائي";
    }
    if (tenderId && Number(parent.tender_id) !== tenderId) return "المناقصة لا تطابق الضمان الابتدائي الأب";
    tenderId = Number(parent.tender_id);
    const existingChild = resultRows(await db.execute(sql`
      SELECT id FROM contracting_guarantees
       WHERE company_id = ${cid} AND parent_guarantee_id = ${parentGuaranteeId}
         AND guarantee_type = 'performance' AND archived_at IS NULL
       LIMIT 1
    `))[0];
    if (existingChild) return "تم إنشاء ضمان نهائي لهذا الضمان الابتدائي بالفعل";
  }
  return { tenderId, contractKind, ownerContractId, subcontractId, parentGuaranteeId };
}

router.get("/guarantees/options", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const allowed = getAllowedBranchIds(req);
    const bankScope = allowed === null
      ? sql`true`
      : allowed.length === 0
        ? sql`false`
        : sql`(b.branch_id IS NULL OR b.branch_id IN (${sql.join(allowed.map(id => sql`${id}`), sql`, `)})
          OR b.branch_ids && ARRAY[${sql.join(allowed.map(id => sql`${id}`), sql`, `)}]::integer[])`;
    const banks = resultRows(await db.execute(sql`
      SELECT b.id, b.code, b.name_ar AS "nameAr", b.name_en AS "nameEn", b.bank_name AS "bankName"
        FROM bank_accounts b
       WHERE b.company_id = ${cid} AND b.is_active = true AND ${bankScope}
       ORDER BY b.code
    `));
    const customers = canAccessModule(req.authUser, "customers", "view")
      ? resultRows(await db.execute(sql`
          SELECT id, code, name_ar AS "nameAr", name_en AS "nameEn"
            FROM customers WHERE company_id = ${cid}
           ORDER BY name_ar
        `))
      : [];
    res.json({ banks, customers });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل خيارات الضمانات" });
  }
});

router.get("/tenders", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = positiveId(req.query.projectId);
    const rootProjectId = positiveId(req.query.rootProjectId);
    const status = String(req.query.status ?? "");
    const conditions: any[] = [sql`t.company_id = ${cid}`, sql`t.archived_at IS NULL`];
    if (projectId) conditions.push(sql`t.project_id = ${projectId}`);
    if (rootProjectId) conditions.push(sql`(p.id = ${rootProjectId} OR p.parent_id = ${rootProjectId})`);
    if (status) conditions.push(sql`t.status = ${status}`);
    const allowed = getAllowedBranchIds(req);
    if (allowed !== null) {
      conditions.push(allowed.length
        ? sql`p.branch_id IN (${sql.join(allowed.map(id => sql`${id}`), sql`, `)})`
        : sql`false`);
    }
    const rows = resultRows(await db.execute(sql`
      SELECT t.*, p.code AS "projectCode", p.name_ar AS "projectName",
             c.name_ar AS "customerName",
             COALESCE(oc.contract_number, sc.contract_number) AS "awardedContractNumber"
        FROM contracting_tenders t
        JOIN contracting_projects p ON p.id = t.project_id AND p.company_id = t.company_id
        LEFT JOIN customers c ON c.id = t.customer_id AND c.company_id = t.company_id
        LEFT JOIN contracting_owner_contracts oc ON oc.id = t.awarded_owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = t.awarded_subcontract_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY t.tender_date DESC, t.id DESC
    `));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل المناقصات" });
  }
});

router.get("/tenders/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "المناقصة غير صالحة" }); return; }
    const row = resultRows(await db.execute(sql`
      SELECT t.*, p.code AS "projectCode", p.name_ar AS "projectName",
             c.name_ar AS "customerName",
             COALESCE(oc.contract_number, sc.contract_number) AS "awardedContractNumber"
        FROM contracting_tenders t
        JOIN contracting_projects p ON p.id = t.project_id AND p.company_id = t.company_id
        LEFT JOIN customers c ON c.id = t.customer_id AND c.company_id = t.company_id
        LEFT JOIN contracting_owner_contracts oc ON oc.id = t.awarded_owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = t.awarded_subcontract_id
       WHERE t.id = ${id} AND t.company_id = ${cid} AND t.archived_at IS NULL
       LIMIT 1
    `))[0];
    if (!row) { res.status(404).json({ error: "المناقصة غير موجودة" }); return; }
    const projectError = await ensureProject(cid, Number(row.project_id), req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل المناقصة" });
  }
});

router.post("/tenders", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body ?? {};
    const projectId = positiveId(b.projectId);
    if (!projectId || !String(b.tenderNumber ?? "").trim() || !String(b.title ?? "").trim() || !b.tenderDate) {
      res.status(400).json({ error: "المشروع ورقم المناقصة والعنوان والتاريخ مطلوبة" }); return;
    }
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    const customerId = positiveId(b.customerId);
    if (customerId) {
      if (!canAccessModule(req.authUser, "customers", "view")) {
        res.status(403).json({ error: "لا تملك صلاحية عرض العملاء" }); return;
      }
      const customerError = await ensureGuaranteeCustomer(cid, customerId);
      if (customerError) { res.status(400).json({ error: customerError }); return; }
    }
    const status = String(b.status ?? "draft");
    if (!["draft", "submitted", "under_review"].includes(status)) {
      res.status(400).json({ error: "تبدأ المناقصة كمسودة أو مقدمة أو قيد المراجعة" }); return;
    }
    const amountError = validateNonNegative(b.estimatedValue ?? 0, "القيمة التقديرية");
    if (amountError) { res.status(400).json({ error: amountError }); return; }
    const row = resultRows(await db.execute(sql`
      INSERT INTO contracting_tenders (
        company_id, project_id, customer_id, tender_number, title, tender_date,
        submission_date, estimated_value, status, notes, created_by_user_id
      ) VALUES (
        ${cid}, ${projectId}, ${customerId}, ${String(b.tenderNumber).trim()},
        ${String(b.title).trim()}, ${String(b.tenderDate)}, ${b.submissionDate || null},
        ${String(b.estimatedValue ?? 0)}, ${status}, ${b.notes || null}, ${req.authUser?.id ?? null}
      ) RETURNING *
    `))[0];
    res.status(201).json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر إنشاء المناقصة" });
  }
});

router.put("/tenders/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "المناقصة غير صالحة" }); return; }
    const b = req.body ?? {};
    const current = resultRows(await db.execute(sql`
      SELECT * FROM contracting_tenders
       WHERE id = ${id} AND company_id = ${cid} AND archived_at IS NULL LIMIT 1
    `))[0];
    if (!current) { res.status(404).json({ error: "المناقصة غير موجودة" }); return; }
    const currentProjectError = await ensureProject(cid, Number(current.project_id), req);
    if (currentProjectError) {
      res.status(projectErrorStatus(currentProjectError)).json({ error: currentProjectError }); return;
    }
    if (current.status === "awarded" && (b.projectId !== undefined || b.status !== undefined)) {
      res.status(409).json({ error: "لا يمكن نقل أو تغيير حالة مناقصة تمت ترسيتها" }); return;
    }
    const projectId = b.projectId === undefined ? Number(current.project_id) : positiveId(b.projectId);
    if (!projectId) { res.status(400).json({ error: "المشروع غير صالح" }); return; }
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    if (projectId !== Number(current.project_id)) {
      const linked = resultRows(await db.execute(sql`
        SELECT 1 FROM contracting_guarantees
         WHERE company_id = ${cid} AND tender_id = ${id} AND archived_at IS NULL LIMIT 1
      `)).length;
      if (linked) { res.status(409).json({ error: "لا يمكن نقل مناقصة لها خطابات ضمان" }); return; }
    }
    const customerId = b.customerId === undefined
      ? current.customer_id == null ? null : Number(current.customer_id)
      : positiveId(b.customerId);
    if (customerId) {
      if (!canAccessModule(req.authUser, "customers", "view")) {
        res.status(403).json({ error: "لا تملك صلاحية عرض العملاء" }); return;
      }
      const customerError = await ensureGuaranteeCustomer(cid, customerId);
      if (customerError) { res.status(400).json({ error: customerError }); return; }
    }
    const status = b.status === undefined ? String(current.status) : String(b.status);
    if (!TENDER_STATUSES.has(status) || status === "awarded") {
      res.status(400).json({ error: "حالة المناقصة غير صالحة أو تتطلب مسار الترسية" }); return;
    }
    const estimatedValue = b.estimatedValue === undefined ? current.estimated_value : b.estimatedValue;
    const amountError = validateNonNegative(estimatedValue, "القيمة التقديرية");
    if (amountError) { res.status(400).json({ error: amountError }); return; }
    const row = resultRows(await db.execute(sql`
      UPDATE contracting_tenders SET
        project_id = ${projectId}, customer_id = ${customerId},
        tender_number = ${String(b.tenderNumber ?? current.tender_number).trim()},
        title = ${String(b.title ?? current.title).trim()},
        tender_date = ${String(b.tenderDate ?? current.tender_date)},
        submission_date = ${b.submissionDate === undefined ? current.submission_date : b.submissionDate || null},
        estimated_value = ${String(estimatedValue)}, status = ${status},
        notes = ${b.notes === undefined ? current.notes : b.notes || null}, updated_at = NOW()
       WHERE id = ${id} AND company_id = ${cid}
       RETURNING *
    `))[0];
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر تعديل المناقصة" });
  }
});

router.put("/tenders/:id/award", requirePermission("contracting", "approve"), async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    const kind = String(req.body?.contractKind ?? "");
    const contractId = positiveId(req.body?.contractId);
    if (!id || !contractId || !["owner", "subcontract"].includes(kind)) {
      res.status(400).json({ error: "نوع العقد والعقد الحالي مطلوبان للترسية" }); return;
    }
    const row = await db.transaction(async (tx) => {
      const tender = resultRows(await tx.execute(sql`
        SELECT * FROM contracting_tenders
         WHERE id = ${id} AND company_id = ${cid} AND archived_at IS NULL FOR UPDATE
      `))[0];
      if (!tender) throw Object.assign(new Error("المناقصة غير موجودة"), { status: 404 });
      if (tender.status === "awarded") throw Object.assign(new Error("تمت ترسية المناقصة بالفعل"), { status: 409 });
      if (!["submitted", "under_review"].includes(String(tender.status))) {
        throw Object.assign(new Error("يجب أن تكون المناقصة مقدمة أو قيد المراجعة قبل الترسية"), { status: 422 });
      }
      const projectError = await ensureProject(cid, Number(tender.project_id), req);
      if (projectError) throw Object.assign(new Error(projectError), { status: projectErrorStatus(projectError) });
      const contractError = kind === "owner"
        ? await ensureOwnerContract(cid, Number(tender.project_id), contractId)
        : await ensureSubContract(cid, Number(tender.project_id), contractId);
      if (contractError) throw Object.assign(new Error(contractError), { status: 422 });
      return resultRows(await tx.execute(sql`
        UPDATE contracting_tenders SET
          status = 'awarded', awarded_contract_kind = ${kind},
          awarded_owner_contract_id = ${kind === "owner" ? contractId : null},
          awarded_subcontract_id = ${kind === "subcontract" ? contractId : null},
          awarded_at = NOW(), updated_at = NOW()
         WHERE id = ${id} AND company_id = ${cid}
         RETURNING *
      `))[0];
    });
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر ترسية المناقصة" });
  }
});

router.delete("/tenders/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "المناقصة غير صالحة" }); return; }
    const tender = resultRows(await db.execute(sql`
      SELECT project_id FROM contracting_tenders
       WHERE company_id = ${cid} AND id = ${id} AND archived_at IS NULL LIMIT 1
    `))[0];
    if (!tender) { res.status(404).json({ error: "المناقصة غير موجودة" }); return; }
    const projectError = await ensureProject(cid, Number(tender.project_id), req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    const linked = resultRows(await db.execute(sql`
      SELECT 1 FROM contracting_guarantees
       WHERE company_id = ${cid} AND tender_id = ${id} AND archived_at IS NULL LIMIT 1
    `)).length;
    if (linked) { res.status(409).json({ error: "لا يمكن أرشفة مناقصة لها خطابات ضمان نشطة" }); return; }
    const rows = resultRows(await db.execute(sql`
      UPDATE contracting_tenders SET archived_at = NOW(), archived_by_user_id = ${req.authUser?.id ?? null}, updated_at = NOW()
       WHERE id = ${id} AND company_id = ${cid} AND archived_at IS NULL
       RETURNING id
    `));
    if (!rows.length) { res.status(404).json({ error: "المناقصة غير موجودة" }); return; }
    res.json({ ok: true, archived: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر أرشفة المناقصة" });
  }
});

router.get("/guarantees", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const conditions: any[] = [sql`g.company_id = ${cid}`, sql`g.archived_at IS NULL`];
    const numericFilters: Array<[unknown, any]> = [
      [req.query.projectId, sql`g.project_id`],
      [req.query.rootProjectId, sql`COALESCE(p.parent_id, p.id)`],
      [req.query.tenderId, sql`g.tender_id`],
      [req.query.bankAccountId ?? req.query.bankId, sql`g.bank_account_id`],
      [req.query.beneficiaryCustomerId ?? req.query.beneficiaryId, sql`g.beneficiary_customer_id`],
    ];
    for (const [raw, column] of numericFilters) {
      const value = positiveId(raw);
      if (value) conditions.push(sql`${column} = ${value}`);
    }
    const contractId = positiveId(req.query.contractId);
    const contractKind = String(req.query.contractKind ?? "");
    if (contractId && contractKind === "owner") conditions.push(sql`g.owner_contract_id = ${contractId}`);
    if (contractId && contractKind === "subcontract") conditions.push(sql`g.subcontract_id = ${contractId}`);
    if (contractKind) conditions.push(sql`g.contract_kind = ${contractKind}`);
    for (const [raw, column] of [
      [req.query.guaranteeType ?? req.query.type, sql`g.guarantee_type`],
      [req.query.status ?? req.query.state, sql`g.status`],
      [req.query.contractType, sql`COALESCE(oc.contract_type, sc.contract_type)`],
    ] as const) {
      const value = String(raw ?? "");
      if (value) conditions.push(sql`${column} = ${value}`);
    }
    for (const [raw, expression, operator] of [
      [req.query.issueFrom, sql`g.issue_date`, ">="],
      [req.query.issueTo, sql`g.issue_date`, "<="],
      [req.query.expiryFrom, sql`g.expiry_date`, ">="],
      [req.query.expiryTo, sql`g.expiry_date`, "<="],
    ] as const) {
      const value = String(raw ?? "");
      if (!value) continue;
      if (operator === ">=") conditions.push(sql`${expression} >= ${value}`);
      else conditions.push(sql`${expression} <= ${value}`);
    }
    const search = String(req.query.q ?? "").trim();
    if (search) {
      conditions.push(sql`(
        g.guarantee_number ILIKE ${`%${search}%`}
        OR COALESCE(g.purpose, '') ILIKE ${`%${search}%`}
        OR COALESCE(t.tender_number, '') ILIKE ${`%${search}%`}
        OR COALESCE(oc.contract_number, sc.contract_number, '') ILIKE ${`%${search}%`}
      )`);
    }
    const allowed = getAllowedBranchIds(req);
    if (allowed !== null) {
      conditions.push(allowed.length
        ? sql`p.branch_id IN (${sql.join(allowed.map(id => sql`${id}`), sql`, `)})`
        : sql`false`);
    }
    const rows = resultRows(await db.execute(sql`
      SELECT g.*, p.code AS "projectCode", p.name_ar AS "projectName",
             parent_p.code AS "rootProjectCode", parent_p.name_ar AS "rootProjectName",
             t.tender_number AS "tenderNumber", t.title AS "tenderTitle",
             COALESCE(oc.contract_number, sc.contract_number) AS "contractNumber",
             COALESCE(oc.contract_type, sc.contract_type) AS "contractType",
             b.name_ar AS "bankName", b.bank_name AS "bankInstitutionName",
             c.name_ar AS "beneficiaryName",
             pg.guarantee_number AS "parentGuaranteeNumber"
        FROM contracting_guarantees g
        JOIN contracting_projects p ON p.id = g.project_id AND p.company_id = g.company_id
        LEFT JOIN contracting_projects parent_p ON parent_p.id = p.parent_id AND parent_p.company_id = p.company_id
        LEFT JOIN contracting_tenders t ON t.id = g.tender_id AND t.company_id = g.company_id
        LEFT JOIN contracting_owner_contracts oc ON oc.id = g.owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = g.subcontract_id
        JOIN bank_accounts b ON b.id = g.bank_account_id AND b.company_id = g.company_id
        LEFT JOIN customers c ON c.id = g.beneficiary_customer_id AND c.company_id = g.company_id
        LEFT JOIN contracting_guarantees pg ON pg.id = g.parent_guarantee_id AND pg.company_id = g.company_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY g.issue_date DESC, g.id DESC
    `));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل خطابات الضمان" });
  }
});

router.post("/guarantees", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const b = req.body ?? {};
    const projectId = positiveId(b.projectId);
    const bankAccountId = positiveId(b.bankAccountId);
    const beneficiaryCustomerId = positiveId(b.beneficiaryCustomerId);
    const guaranteeType = String(b.guaranteeType ?? "");
    if (!projectId || !bankAccountId || !String(b.guaranteeNumber ?? "").trim()
      || !GUARANTEE_TYPES.has(guaranteeType) || !b.issueDate || !b.expiryDate) {
      res.status(400).json({ error: "المشروع والبنك ورقم ونوع وتواريخ خطاب الضمان مطلوبة" }); return;
    }
    const projectError = await ensureProject(cid, projectId, req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    const bankError = await ensureGuaranteeBank(cid, bankAccountId);
    if (bankError) { res.status(400).json({ error: bankError }); return; }
    if (beneficiaryCustomerId) {
      if (!canAccessModule(req.authUser, "customers", "view")) {
        res.status(403).json({ error: "لا تملك صلاحية عرض العملاء" }); return;
      }
      const customerError = await ensureGuaranteeCustomer(cid, beneficiaryCustomerId);
      if (customerError) { res.status(400).json({ error: customerError }); return; }
    }
    const amountError = validateNonNegative(b.amount, "قيمة خطاب الضمان");
    if (amountError || Number(b.amount) <= 0) {
      res.status(400).json({ error: amountError || "قيمة خطاب الضمان يجب أن تكون أكبر من صفر" }); return;
    }
    if (String(b.expiryDate) < String(b.issueDate)) {
      res.status(400).json({ error: "تاريخ الانتهاء يجب ألا يسبق تاريخ الإصدار" }); return;
    }
    const relationship = await guaranteeRelationship(cid, projectId, b);
    if (typeof relationship === "string") { res.status(422).json({ error: relationship }); return; }
    const status = String(b.status ?? "draft");
    if (!["draft", "issued"].includes(status)) {
      res.status(400).json({ error: "يبدأ خطاب الضمان كمسودة أو مُصدر" }); return;
    }
    const row = resultRows(await db.execute(sql`
      INSERT INTO contracting_guarantees (
        company_id, project_id, tender_id, contract_kind, owner_contract_id,
        subcontract_id, parent_guarantee_id, bank_account_id, beneficiary_customer_id,
        guarantee_number, guarantee_type, amount, issue_date, expiry_date,
        status, purpose, notes, created_by_user_id
      ) VALUES (
        ${cid}, ${projectId}, ${relationship.tenderId}, ${relationship.contractKind},
        ${relationship.ownerContractId}, ${relationship.subcontractId},
        ${relationship.parentGuaranteeId}, ${bankAccountId}, ${beneficiaryCustomerId},
        ${String(b.guaranteeNumber).trim()}, ${guaranteeType}, ${String(b.amount)},
        ${String(b.issueDate)}, ${String(b.expiryDate)}, ${status},
        ${b.purpose || null}, ${b.notes || null}, ${req.authUser?.id ?? null}
      ) RETURNING *
    `))[0];
    res.status(201).json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر إنشاء خطاب الضمان" });
  }
});

router.patch("/guarantees/:id", async (req, res) => {
  const cid = await scope(req, res); if (!cid) return;
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ error: "خطاب الضمان غير صالح" }); return; }
  const current = resultRows(await db.execute(sql`
    SELECT project_id, guarantee_type FROM contracting_guarantees
     WHERE id = ${id} AND company_id = ${cid} AND archived_at IS NULL LIMIT 1
  `))[0];
  if (!current) { res.status(404).json({ error: "خطاب الضمان غير موجود" }); return; }
  const projectError = await ensureProject(cid, Number(current.project_id), req);
  if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
  const b = req.body ?? {};
  const relationshipFields = [
    "projectId", "project_id", "tenderId", "tender_id", "contractKind", "contract_kind",
    "contractId", "ownerContractId", "owner_contract_id", "subcontractId", "subcontract_id",
    "parentGuaranteeId", "parent_guarantee_id", "guaranteeType", "guarantee_type",
  ];
  if (relationshipFields.some((field) => b[field] !== undefined)) {
    res.status(409).json({
      error: current.guarantee_type === "initial"
        ? "لا يمكن تحويل الضمان الابتدائي أو تغيير روابطه؛ أنشئ ضمان أداء جديداً كابن له"
        : "نوع وروابط خطاب الضمان غير قابلة للتعديل",
    });
    return;
  }
  res.status(405).json({ error: "استخدم PUT لتعديل البيانات أو مسار lifecycle لتغيير الحالة" });
});

router.put("/guarantees/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "خطاب الضمان غير صالح" }); return; }
    const b = req.body ?? {};
    const current = resultRows(await db.execute(sql`
      SELECT * FROM contracting_guarantees
       WHERE id = ${id} AND company_id = ${cid} AND archived_at IS NULL LIMIT 1
    `))[0];
    if (!current) { res.status(404).json({ error: "خطاب الضمان غير موجود" }); return; }
    const projectError = await ensureProject(cid, Number(current.project_id), req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    for (const immutable of [
      "projectId", "project_id", "tenderId", "tender_id", "contractKind", "contract_kind",
      "contractId", "ownerContractId", "owner_contract_id", "subcontractId", "subcontract_id",
      "parentGuaranteeId", "parent_guarantee_id", "guaranteeType", "guarantee_type", "status",
    ]) {
      if (b[immutable] !== undefined) {
        res.status(409).json({ error: "نوع وروابط وحالة خطاب الضمان لا تعدل من نموذج البيانات؛ استخدم مسار دورة الحالة أو أنشئ ضماناً جديداً" }); return;
      }
    }
    const bankAccountId = b.bankAccountId === undefined ? Number(current.bank_account_id) : positiveId(b.bankAccountId);
    if (!bankAccountId) { res.status(400).json({ error: "البنك مطلوب" }); return; }
    const bankError = await ensureGuaranteeBank(cid, bankAccountId);
    if (bankError) { res.status(400).json({ error: bankError }); return; }
    const beneficiaryCustomerId = b.beneficiaryCustomerId === undefined
      ? current.beneficiary_customer_id == null ? null : Number(current.beneficiary_customer_id)
      : positiveId(b.beneficiaryCustomerId);
    if (beneficiaryCustomerId) {
      if (!canAccessModule(req.authUser, "customers", "view")) {
        res.status(403).json({ error: "لا تملك صلاحية عرض العملاء" }); return;
      }
      const customerError = await ensureGuaranteeCustomer(cid, beneficiaryCustomerId);
      if (customerError) { res.status(400).json({ error: customerError }); return; }
    }
    const amount = b.amount === undefined ? current.amount : b.amount;
    const amountError = validateNonNegative(amount, "قيمة خطاب الضمان");
    if (amountError || Number(amount) <= 0) {
      res.status(400).json({ error: amountError || "قيمة خطاب الضمان يجب أن تكون أكبر من صفر" }); return;
    }
    const issueDate = String(b.issueDate ?? current.issue_date);
    const expiryDate = String(b.expiryDate ?? current.expiry_date);
    if (expiryDate < issueDate) { res.status(400).json({ error: "تاريخ الانتهاء يجب ألا يسبق تاريخ الإصدار" }); return; }
    const row = resultRows(await db.execute(sql`
      UPDATE contracting_guarantees SET
        bank_account_id = ${bankAccountId}, beneficiary_customer_id = ${beneficiaryCustomerId},
        guarantee_number = ${String(b.guaranteeNumber ?? current.guarantee_number).trim()},
        amount = ${String(amount)}, issue_date = ${issueDate}, expiry_date = ${expiryDate},
        purpose = ${b.purpose === undefined ? current.purpose : b.purpose || null},
        notes = ${b.notes === undefined ? current.notes : b.notes || null}, updated_at = NOW()
       WHERE id = ${id} AND company_id = ${cid}
       RETURNING *
    `))[0];
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر تعديل خطاب الضمان" });
  }
});

router.put("/guarantees/:id/lifecycle", requirePermission("contracting", "approve"), async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    const nextStatus = String(req.body?.status ?? "");
    if (!id || !GUARANTEE_STATUSES.has(nextStatus)) {
      res.status(400).json({ error: "حالة خطاب الضمان غير صالحة" }); return;
    }
    const row = await db.transaction(async (tx) => {
      const current = resultRows(await tx.execute(sql`
        SELECT g.*, p.branch_id FROM contracting_guarantees g
        JOIN contracting_projects p ON p.id = g.project_id AND p.company_id = g.company_id
         WHERE g.id = ${id} AND g.company_id = ${cid} AND g.archived_at IS NULL FOR UPDATE
      `))[0];
      if (!current) throw Object.assign(new Error("خطاب الضمان غير موجود"), { status: 404 });
      if (!projectBranchVisible(req, current.branch_id == null ? null : Number(current.branch_id))) {
        throw Object.assign(new Error("ليس لديك صلاحية هذا الفرع"), { status: 403 });
      }
      if (!GUARANTEE_TRANSITIONS[String(current.status)]?.has(nextStatus)) {
        throw Object.assign(new Error(`لا يمكن نقل خطاب الضمان من ${current.status} إلى ${nextStatus}`), { status: 409 });
      }
      const extendedExpiry = nextStatus === "extended"
        ? String(req.body?.expiryDate ?? "")
        : String(current.expiry_date);
      if (nextStatus === "extended" && (!extendedExpiry || extendedExpiry <= String(current.expiry_date))) {
        throw Object.assign(new Error("تمديد خطاب الضمان يتطلب تاريخ انتهاء جديداً لاحقاً للتاريخ الحالي"), { status: 422 });
      }
      return resultRows(await tx.execute(sql`
        UPDATE contracting_guarantees SET status = ${nextStatus},
          expiry_date = ${extendedExpiry},
          released_at = ${nextStatus === "released" ? new Date() : current.released_at},
          updated_at = NOW()
         WHERE id = ${id} AND company_id = ${cid}
         RETURNING *
      `))[0];
    });
    res.json(row);
  } catch (e: any) {
    res.status(Number(e?.status) || 500).json({ error: e?.message ?? "تعذر تحديث دورة خطاب الضمان" });
  }
});

router.delete("/guarantees/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "خطاب الضمان غير صالح" }); return; }
    const current = resultRows(await db.execute(sql`
      SELECT project_id FROM contracting_guarantees
       WHERE company_id = ${cid} AND id = ${id} AND archived_at IS NULL LIMIT 1
    `))[0];
    if (!current) { res.status(404).json({ error: "خطاب الضمان غير موجود" }); return; }
    const projectError = await ensureProject(cid, Number(current.project_id), req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    const child = resultRows(await db.execute(sql`
      SELECT 1 FROM contracting_guarantees
       WHERE company_id = ${cid} AND parent_guarantee_id = ${id} AND archived_at IS NULL LIMIT 1
    `)).length;
    if (child) { res.status(409).json({ error: "لا يمكن أرشفة ضمان ابتدائي مرتبط بضمان نهائي لاحق" }); return; }
    const rows = resultRows(await db.execute(sql`
      UPDATE contracting_guarantees SET archived_at = NOW(),
        archived_by_user_id = ${req.authUser?.id ?? null}, updated_at = NOW()
       WHERE id = ${id} AND company_id = ${cid} AND archived_at IS NULL
       RETURNING id
    `));
    if (!rows.length) { res.status(404).json({ error: "خطاب الضمان غير موجود" }); return; }
    res.json({ ok: true, archived: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر أرشفة خطاب الضمان" });
  }
});

router.get("/contracts/:kind/:id/guarantee-summary", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const kind = String(req.params.kind);
    const id = positiveId(req.params.id);
    if (!id || !["owner", "subcontract"].includes(kind)) {
      res.status(400).json({ error: "العقد غير صالح" }); return;
    }
    const contract = resultRows(await db.execute(kind === "owner" ? sql`
      SELECT project_id FROM contracting_owner_contracts WHERE id = ${id} AND company_id = ${cid}
    ` : sql`
      SELECT project_id FROM contracting_sub_contracts WHERE id = ${id} AND company_id = ${cid}
    `))[0];
    if (!contract) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    const projectError = await ensureProject(cid, Number(contract.project_id), req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    const rows = resultRows(await db.execute(sql`
      SELECT guarantee_type AS "guaranteeType", status, count(*)::int AS count,
             COALESCE(sum(amount), 0)::text AS amount
        FROM contracting_guarantees
       WHERE company_id = ${cid} AND archived_at IS NULL AND contract_kind = ${kind}
         AND ${kind === "owner" ? sql`owner_contract_id = ${id}` : sql`subcontract_id = ${id}`}
       GROUP BY guarantee_type, status ORDER BY guarantee_type, status
    `));
    res.json({
      contractKind: kind,
      contractId: id,
      totalCount: rows.reduce((sum, item) => sum + Number(item.count), 0),
      totalAmount: rows.reduce((sum, item) => sum + Number(item.amount), 0).toFixed(2),
      rows,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل ملخص ضمانات العقد" });
  }
});

router.get("/guarantees/report", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const rootProjectId = positiveId(req.query.rootProjectId);
    const allowed = getAllowedBranchIds(req);
    const conditions: any[] = [sql`p.company_id = ${cid}`];
    if (rootProjectId) conditions.push(sql`(p.id = ${rootProjectId} OR p.parent_id = ${rootProjectId})`);
    if (allowed !== null) conditions.push(allowed.length
      ? sql`p.branch_id IN (${sql.join(allowed.map(id => sql`${id}`), sql`, `)})`
      : sql`false`);
    const rows = resultRows(await db.execute(sql`
      SELECT COALESCE(root.id, p.id) AS "rootProjectId",
             COALESCE(root.code, p.code) AS "rootProjectCode",
             COALESCE(root.name_ar, p.name_ar) AS "rootProjectName",
             p.id AS "projectId", p.code AS "projectCode", p.name_ar AS "projectName",
             g.contract_kind AS "contractKind",
             COALESCE(g.owner_contract_id, g.subcontract_id) AS "contractId",
             COALESCE(oc.contract_number, sc.contract_number) AS "contractNumber",
             count(g.id)::int AS "guaranteeCount",
             COALESCE(sum(g.amount), 0)::text AS "guaranteeAmount"
        FROM contracting_projects p
        LEFT JOIN contracting_projects root ON root.id = p.parent_id AND root.company_id = p.company_id
        LEFT JOIN contracting_guarantees g ON g.project_id = p.id AND g.company_id = p.company_id AND g.archived_at IS NULL
        LEFT JOIN contracting_owner_contracts oc ON oc.id = g.owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = g.subcontract_id
       WHERE ${sql.join(conditions, sql` AND `)}
       GROUP BY COALESCE(root.id, p.id), COALESCE(root.code, p.code), COALESCE(root.name_ar, p.name_ar),
                p.id, p.code, p.name_ar, g.contract_kind,
                COALESCE(g.owner_contract_id, g.subcontract_id),
                COALESCE(oc.contract_number, sc.contract_number)
       ORDER BY COALESCE(root.code, p.code), p.code, "contractNumber"
    `));
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل تقرير الضمانات" });
  }
});

router.get("/guarantees/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = positiveId(req.params.id);
    if (!id) { res.status(400).json({ error: "خطاب الضمان غير صالح" }); return; }
    const row = resultRows(await db.execute(sql`
      SELECT g.*, p.code AS "projectCode", p.name_ar AS "projectName",
             t.tender_number AS "tenderNumber", t.title AS "tenderTitle",
             COALESCE(oc.contract_number, sc.contract_number) AS "contractNumber",
             b.name_ar AS "bankName", c.name_ar AS "beneficiaryName",
             pg.guarantee_number AS "parentGuaranteeNumber"
        FROM contracting_guarantees g
        JOIN contracting_projects p ON p.id = g.project_id AND p.company_id = g.company_id
        LEFT JOIN contracting_tenders t ON t.id = g.tender_id AND t.company_id = g.company_id
        LEFT JOIN contracting_owner_contracts oc ON oc.id = g.owner_contract_id
        LEFT JOIN contracting_sub_contracts sc ON sc.id = g.subcontract_id
        JOIN bank_accounts b ON b.id = g.bank_account_id AND b.company_id = g.company_id
        LEFT JOIN customers c ON c.id = g.beneficiary_customer_id AND c.company_id = g.company_id
        LEFT JOIN contracting_guarantees pg ON pg.id = g.parent_guarantee_id AND pg.company_id = g.company_id
       WHERE g.id = ${id} AND g.company_id = ${cid} AND g.archived_at IS NULL
       LIMIT 1
    `))[0];
    if (!row) { res.status(404).json({ error: "خطاب الضمان غير موجود" }); return; }
    const projectError = await ensureProject(cid, Number(row.project_id), req);
    if (projectError) { res.status(projectErrorStatus(projectError)).json({ error: projectError }); return; }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "تعذر تحميل خطاب الضمان" });
  }
});

// ─────────────────── PROGRESS BILLS (مستخلصات) ───────────────────
// Bills now carry a `direction`:
//   outgoing — مستخلص يصدره مكتبنا للمالك (claim against client)
//   incoming — مستخلص يصدره المقاول الباطن لنا (we owe a sub-contractor)
// Filter via ?direction=outgoing|incoming. Defaults to all.

function numberChanged(left: unknown, right: unknown): boolean {
  const a = Number(left ?? 0);
  const b = Number(right ?? 0);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) > 0.000001 : String(left ?? "") !== String(right ?? "");
}

function aggregateProgressRequestedOnCreate(body: any): boolean {
  const hasContract = body?.direction === "incoming"
    ? body?.subcontractorContractId != null && body?.subcontractorContractId !== ""
    : body?.ownerContractId != null && body?.ownerContractId !== "";
  // Existing clients create a blank 0% draft before adding detail lines. Do
  // not reinterpret that legacy shape as aggregate mode until the user
  // actually supplies a percentage (or the new UI sends its explicit marker).
  return Boolean(body?.aggregateProgress === true)
    || (hasContract && body?.progressPercent !== undefined && Number(body.progressPercent) > 0);
}

/**
 * The aggregate percentage editor is intentionally separate from detailed
 * bill-line allocation.  A contract's value is VAT-exclusive; approved
 * change orders are additive to the selected base contract only.
 */
async function aggregateAdjustedContractValue(
  companyId: number,
  projectId: number,
  direction: BillDirection,
  ownerContractId: number | null,
  subcontractorContractId: number | null,
): Promise<number> {
  if (direction === "incoming") {
    const [contract] = await db.select({ value: contractingSubContractsTable.value })
      .from(contractingSubContractsTable)
      .where(and(
        eq(contractingSubContractsTable.id, Number(subcontractorContractId)),
        eq(contractingSubContractsTable.companyId, companyId),
        eq(contractingSubContractsTable.projectId, projectId),
      ));
    if (!contract) throw Object.assign(new Error("عقد الباطن غير صالح لنطاق المستخلص"), { status: 422 });
    return Number(contract.value ?? 0);
  }

  const [selected] = await db.select({
    id: contractingOwnerContractsTable.id,
    value: contractingOwnerContractsTable.value,
    contractType: contractingOwnerContractsTable.contractType,
    parentContractId: contractingOwnerContractsTable.parentContractId,
  }).from(contractingOwnerContractsTable).where(and(
    eq(contractingOwnerContractsTable.id, Number(ownerContractId)),
    eq(contractingOwnerContractsTable.companyId, companyId),
    eq(contractingOwnerContractsTable.projectId, projectId),
  ));
  if (!selected) throw Object.assign(new Error("عقد المالك غير صالح لنطاق المستخلص"), { status: 422 });

  const baseId = ["change_order", "addendum"].includes(String(selected.contractType))
    ? selected.parentContractId ?? selected.id
    : selected.id;
  const [base] = await db.select({ value: contractingOwnerContractsTable.value })
    .from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.id, baseId),
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, projectId),
    ));
  const children = await db.select({ value: contractingOwnerContractsTable.value })
    .from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, projectId),
      eq(contractingOwnerContractsTable.parentContractId, baseId),
      inArray(contractingOwnerContractsTable.contractType, ["change_order", "addendum"]),
      eq(contractingOwnerContractsTable.status, "approved"),
    ));
  return Number(base?.value ?? selected.value ?? 0)
    + children.reduce((sum, child) => sum + Number(child.value ?? 0), 0);
}

async function aggregatePriorAmounts(
  companyId: number,
  projectId: number,
  direction: BillDirection,
  ownerContractId: number | null,
  subcontractorContractId: number | null,
  excludeBillId?: number | null,
) {
  const conditions: any[] = [
    eq(contractingProgressBillsTable.companyId, companyId),
    eq(contractingProgressBillsTable.projectId, projectId),
    eq(contractingProgressBillsTable.direction, direction),
  ];
  if (direction === "incoming") {
    conditions.push(eq(contractingProgressBillsTable.subcontractorContractId, Number(subcontractorContractId)));
  } else {
    conditions.push(eq(contractingProgressBillsTable.ownerContractId, Number(ownerContractId)));
  }
  const rows = await db.select({
    id: contractingProgressBillsTable.id,
    projectId: contractingProgressBillsTable.projectId,
    direction: contractingProgressBillsTable.direction,
    ownerContractId: contractingProgressBillsTable.ownerContractId,
    subcontractorContractId: contractingProgressBillsTable.subcontractorContractId,
    grossAmount: contractingProgressBillsTable.grossAmount,
    retentionAmount: contractingProgressBillsTable.retentionAmount,
    status: contractingProgressBillsTable.status,
    reversalJournalEntryId: contractingProgressBillsTable.reversalJournalEntryId,
  }).from(contractingProgressBillsTable).where(and(...conditions));
  return priorCertifiedContractGross({
    bills: rows as CertifiedContractProgressBill[],
    projectId,
    direction,
    ownerContractId,
    subcontractorContractId,
    excludeBillId,
  });
}

async function billHasDetailLines(companyId: number, billId: number): Promise<boolean> {
  // The detail tables are additive and are also created during the active
  // schema reconciliation pass. Keep this guard safe for a rolling upgrade.
  await ensureContractingBillDetailsTables();
  const [line] = await db.select({ id: contractingBillLinesTable.id })
    .from(contractingBillLinesTable)
    .where(and(
      eq(contractingBillLinesTable.companyId, companyId),
      eq(contractingBillLinesTable.billId, billId),
    ))
    .limit(1);
  return Boolean(line);
}

async function recomputeAggregateProgress(input: {
  companyId: number;
  projectId: number;
  direction: BillDirection;
  contractorId: number | null;
  ownerContractId: number | null;
  subcontractorContractId: number | null;
  progressPercent: unknown;
  retentionEnabled?: boolean | null;
  retentionPercent: unknown;
  retentionCapPercent?: unknown;
  vatPercent: unknown;
  excludeBillId?: number | null;
}) {
  // This is the strict tenant + project + direction + contractor boundary.
  // Do not derive an adjusted value before it passes this check.
  await assertBillContractScope(db, input.companyId, {
    projectId: input.projectId,
    direction: input.direction,
    contractorId: input.contractorId,
    ownerContractId: input.ownerContractId,
    subcontractorContractId: input.subcontractorContractId,
  }, { requireSelection: true });
  const progress = Number(input.progressPercent);
  const percentageError = validatePercentage(progress, "نسبة الإنجاز");
  if (percentageError) throw Object.assign(new Error(percentageError), { status: 422 });
  const retentionError = validatePercentage(input.retentionPercent, "نسبة المحتجز");
  if (retentionError) throw Object.assign(new Error(retentionError), { status: 422 });
  const vatError = validatePercentage(input.vatPercent, "نسبة الضريبة");
  if (vatError) throw Object.assign(new Error(vatError), { status: 422 });
  const adjustedContractValue = await aggregateAdjustedContractValue(
    input.companyId,
    input.projectId,
    input.direction,
    input.ownerContractId,
    input.subcontractorContractId,
  );
  const prior = await aggregatePriorAmounts(
    input.companyId,
    input.projectId,
    input.direction,
    input.ownerContractId,
    input.subcontractorContractId,
    input.excludeBillId,
  );
  const amounts = aggregateContractProgressAmounts({
    adjustedContractValue,
    progressPercent: progress,
    priorGrossAmount: prior.grossAmount,
    priorRetentionAmount: prior.retentionAmount,
    retentionEnabled: input.retentionEnabled,
    retentionPercent: String(input.retentionPercent),
    retentionCapPercent: input.retentionCapPercent == null ? null : String(input.retentionCapPercent),
    vatPercent: String(input.vatPercent),
  });
  return { ...amounts, adjustedContractValue, prior };
}

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

/**
 * Authoritative, read-only recovery calculation. POST is intentional: the
 * preview accepts the same structured inputs as the approval calculation and
 * never creates a bill, settlement, journal entry, or audit row.
 */
router.post("/projects/:projectId/advance-recovery-preview", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const body = req.body ?? {};
    const direction = body.direction === "incoming" ? "incoming" : body.direction === "outgoing" ? "outgoing" : null;
    if (!direction) {
      res.status(422).json({ error: "اتجاه المستخلص يجب أن يكون outgoing أو incoming" });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.billDate ?? ""))) {
      res.status(422).json({ error: "تاريخ المستخلص مطلوب" });
      return;
    }
    const ownerContractId = body.ownerContractId == null || body.ownerContractId === ""
      ? null : Number(body.ownerContractId);
    const subcontractorContractId = body.subcontractorContractId == null || body.subcontractorContractId === ""
      ? null : Number(body.subcontractorContractId);
    if (
      (direction === "outgoing" && (!Number.isInteger(ownerContractId) || Number(ownerContractId ?? 0) <= 0 || subcontractorContractId != null))
      || (direction === "incoming" && (!Number.isInteger(subcontractorContractId) || Number(subcontractorContractId ?? 0) <= 0 || ownerContractId != null))
    ) {
      res.status(422).json({ error: "يجب تحديد عقد واحد مطابق لاتجاه المستخلص" });
      return;
    }
    if (body.currentCertifiedWorkBeforeVat != null) {
      const current = Number(body.currentCertifiedWorkBeforeVat);
      if (!Number.isFinite(current) || current < 0) {
        res.status(422).json({ error: "قيمة الأعمال المعتمدة الحالية يجب أن تكون غير سالبة" });
        return;
      }
    }
    if (body.progressPercent != null) {
      const progressError = validatePercentage(body.progressPercent, "نسبة الإنجاز");
      if (progressError) { res.status(422).json({ error: progressError }); return; }
    }
    if (body.netDue != null) {
      const netError = validateNonNegative(body.netDue, "صافي المستخلص");
      if (netError) { res.status(422).json({ error: netError }); return; }
    }
    const hasOverride = Object.prototype.hasOwnProperty.call(body, "advanceRecoveryOverrideAmount")
      || Object.prototype.hasOwnProperty.call(body, "advanceRecoveryOverrideReason");
    const result = await getAdvanceRecoveryPreview({
      companyId: cid,
      projectId: Number(req.params.projectId),
      direction,
      ownerContractId,
      subcontractorContractId,
      billDate: String(body.billDate),
      billId: body.billId == null || body.billId === "" ? null : Number(body.billId),
      currentCertifiedWorkBeforeVat: body.currentCertifiedWorkBeforeVat,
      progressPercent: body.progressPercent,
      netDue: body.netDue,
      retentionEnabled: body.retentionEnabled,
      retentionPercent: body.retentionPercent,
      retentionCapPercent: body.retentionCapPercent,
      vatPercent: body.vatPercent,
      overrideAmount: body.advanceRecoveryOverrideAmount,
      overrideReason: body.advanceRecoveryOverrideReason,
      overrideFieldsPresent: hasOverride,
      req,
    });
    res.json({ advanceRecovery: result });
  } catch (e: any) {
    res.status(Number(e?.status) || 400).json({ error: e?.message ?? "تعذر حساب استرداد السلفة" });
  }
});

router.post("/projects/:projectId/bills", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const projectId = Number(req.params.projectId);
    const b = req.body as any;
    const idempotencyKey = parseBillCreateIdempotencyKey(req);
    if (!b?.billDate) {
      res.status(400).json({ error: "تاريخ المستخلص مطلوب" }); return;
    }
    if (["approved", "posted", "partially_paid", "paid"].includes(String(b.status)) || Number(b.paidAmount ?? 0) !== 0) {
      res.status(409).json({ error: "لا يمكن إنشاء مستخلص بترحيل أو سداد مباشر؛ استخدم مسار المحاسبة لاعتماد المستخلص وتسويته" });
      return;
    }

    if (b.direction !== undefined && b.direction !== "incoming" && b.direction !== "outgoing") {
      res.status(400).json({ error: "اتجاه المستخلص غير صالح" }); return;
    }
    const direction = b.direction === "incoming" ? "incoming" : "outgoing";
    const recoveryOverride = advanceRecoveryOverrideRequest(req, direction, b);

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
    const contractIntegrityError = await ensureProjectContractSelection({
      companyId: cid,
      projectId,
      direction,
      contractorId: b.contractorId ? Number(b.contractorId) : null,
      ownerContractId: b.ownerContractId ? Number(b.ownerContractId) : null,
      subcontractorContractId: b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
    });
    if (contractIntegrityError) {
      res.status(400).json({ error: contractIntegrityError }); return;
    }
    const contractApprovalError = await ensureApprovedContract(
      cid,
      projectId,
      direction,
      b.ownerContractId ? Number(b.ownerContractId) : null,
      b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
    );
    if (contractApprovalError) {
      res.status(422).json({ error: contractApprovalError }); return;
    }
    const billRecoverySettings = await contractAdvanceRecoverySettings(
      cid,
      projectId,
      direction,
      b.ownerContractId ? Number(b.ownerContractId) : null,
      b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
    );
    const billRetentionSettings = await contractRetentionSettings(
      cid,
      projectId,
      direction,
      b.ownerContractId ? Number(b.ownerContractId) : null,
      b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
    );

    // Server-side computation. Client may send raw values; we recompute the
    // derived ones here so the math is consistent and tamper-resistant.
    const aggregateRequested = aggregateProgressRequestedOnCreate({ ...b, direction });
    let gross = Number(b.grossAmount ?? 0);
    let retEnabled = billRetentionSettings?.enabled ?? (b.retentionEnabled !== false);
    let retPct = Number(billRetentionSettings?.percent ?? b.retentionPercent ?? 0);
    let retCapPct = billRetentionSettings?.capPercent ?? (b.retentionCapPercent == null ? null : String(b.retentionCapPercent));
    const retentionCapBase = billRetentionSettings && retCapPct != null
      ? await aggregateAdjustedContractValue(
        cid,
        projectId,
        direction,
        b.ownerContractId ? Number(b.ownerContractId) : null,
        b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
      )
      : null;
    let vatPct = b.vatPercent !== undefined ? Number(b.vatPercent) : 15;
    let prevPaid = Number(b.previousPaid ?? 0);
    const requestedRetention = retEnabled
      ? Math.round((gross * retPct / 100) * 100) / 100
      : 0;
    const retentionCapAmount = retentionCapBase == null || retCapPct == null
      ? null
      : Math.round((retentionCapBase * Number(retCapPct) / 100) * 100) / 100;
    let retAmount = retentionCapAmount == null
      ? requestedRetention
      : Math.min(requestedRetention, retentionCapAmount);
    let dueAmount = Math.max(0, Math.round((gross - retAmount - prevPaid) * 100) / 100);
    let vatAmount = Math.round((dueAmount * vatPct / 100) * 100) / 100;
    let netAmount = Math.round((dueAmount + vatAmount) * 100) / 100;
    if (aggregateRequested) {
      const aggregate = await recomputeAggregateProgress({
        companyId: cid,
        projectId,
        direction,
        contractorId: b.contractorId ? Number(b.contractorId) : null,
        ownerContractId: b.ownerContractId ? Number(b.ownerContractId) : null,
        subcontractorContractId: b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
        progressPercent: b.progressPercent ?? 0,
        retentionEnabled: retEnabled,
        retentionPercent: retPct,
        retentionCapPercent: retCapPct,
        vatPercent: b.vatPercent ?? 15,
      });
      gross = Number(aggregate.grossAmount);
      retEnabled = billRetentionSettings?.enabled ?? (b.retentionEnabled !== false);
      retPct = Number(billRetentionSettings?.percent ?? b.retentionPercent ?? 0);
      retCapPct = billRetentionSettings?.capPercent ?? (b.retentionCapPercent == null ? null : String(b.retentionCapPercent));
      vatPct = b.vatPercent !== undefined ? Number(b.vatPercent) : 15;
      prevPaid = Number(aggregate.previousPaid);
      retAmount = Number(aggregate.retentionAmount);
      dueAmount = Number(aggregate.dueAmount);
      vatAmount = Number(aggregate.vatAmount);
      netAmount = Number(aggregate.netAmount);
    }

    const values = {
      companyId: cid, projectId,
      costCenterId: effectiveCostCenterId,
      direction,
      contractorId: b.contractorId ? Number(b.contractorId) : null,
      ownerContractId:         b.ownerContractId         ? Number(b.ownerContractId)         : null,
      subcontractorContractId: b.subcontractorContractId ? Number(b.subcontractorContractId) : null,
      billType: b.billType ?? "interim",
      billDate: b.billDate,
      fromDate: b.fromDate ?? null,
      toDate:   b.toDate   ?? null,
      progressPercent: String(b.progressPercent ?? 0),
      grossAmount: String(gross),
      retentionEnabled: billRetentionSettings ? retEnabled : b.retentionEnabled !== false,
      retentionPercent: String(retPct),
      retentionCapPercent: retCapPct == null ? null : String(retCapPct),
      retentionAmount: String(retAmount),
      previousPaid: String(prevPaid),
      dueAmount: String(dueAmount),
      vatPercent: String(vatPct),
      vatAmount: String(vatAmount),
      netAmount: String(netAmount),
      advanceRecoveryEnabled: billRecoverySettings.enabled,
      advanceRecoveryPercent: billRecoverySettings.percent,
      advanceRecoveryMethod: billRecoverySettings.method,
      advanceRecoveryFixedAmount: billRecoverySettings.fixedAmount,
      advanceRecoveryStartProgressPercent: billRecoverySettings.startProgressPercent,
      advanceRecoveryRequestedAmount: "0",
      advanceRecoveryAmount: "0",
      advanceRecoveryRemainingBefore: "0",
      advanceRecoveryRemainingAfter: "0",
      advanceRecoveryContractAdvanceAmount: billRecoverySettings.contractAdvanceAmount,
      advanceRecoveryTotalPreviouslyRecovered: "0",
      advanceRecoveryOverrideAmount: recoveryOverride.amount,
      advanceRecoveryOverrideReason: recoveryOverride.reason,
      paidAmount: String(b.paidAmount ?? 0),
      status: b.status ?? "draft",
      notes: b.notes ?? null,
    };
    const outcome = await createBillIdempotently({
      companyId: cid,
      userId: req.authUser!.id,
      idempotencyKey,
      // The generated number is intentionally absent: an empty-number retry
      // must claim the same client intent before it can issue another number.
      payloadHash: billCreateFingerprint({
        ...values,
        requestedBillNumber: b.billNumber ? String(b.billNumber) : null,
      }),
      create: async (tx) => {
        // Sequence allocation runs only after this request owns the durable
        // claim. `nextSequenceNumber` deliberately commits its own tiny
        // counter transaction (gaps are safe), but is inside this create path
        // and is never reached by a replay.
        const billNumber = b.billNumber
          ? String(b.billNumber)
          : await nextSequenceNumber(cid, "contracting_bill", {
            branchId: b.branchId ?? null,
            userId: req.authUser?.id ?? null,
            refTable: "contracting_progress_bills",
          });
        if (!billNumber) {
          throw Object.assign(new Error("رقم المستخلص مطلوب (لا يوجد مسلسل مهيأ لمستخلصات المقاولات)"), { status: 400 });
        }
        const [row] = await tx.insert(contractingProgressBillsTable).values({ ...values, billNumber }).returning();
        return row;
      },
    });
    const row = outcome.created ? outcome.row : outcome.result;
    if (outcome.created) {
      await logEvent({
        companyId: cid, projectId, userId: req.authUser!.id,
        eventType: "bill_submitted",
        title: `${direction === "incoming" ? "مستخلص باطن" : "مستخلص مالك"} جديد رقم ${row.billNumber}`,
        description: `صافي: ${row.netAmount} ر.س`,
      });
    }
    res.status(outcome.created ? 201 : 200).json(row);
  } catch (e: any) { res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" }); }
});

router.put("/bills/:id", async (req, res) => {
  try {
    const cid = await scope(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body as any;
    const [cur] = await db.select().from(contractingProgressBillsTable)
      .where(and(eq(contractingProgressBillsTable.id, id), eq(contractingProgressBillsTable.companyId, cid)));
    if (!cur) { res.status(404).json({ error: "غير موجود" }); return; }
    if (["approved", "posted", "partially_paid", "paid", "reversed"].includes(String(cur.status)) ||
        cur.journalEntryId ||
        ["approved", "posted", "partially_paid", "paid"].includes(String(b.status)) || b.paidAmount !== undefined) {
      res.status(409).json({ error: "لا يمكن تعديل مستخلص مرحّل أو معتمد؛ استخدم مسار التصحيح/فك الاعتماد المحاسبي" });
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
    const direction = cur.direction as BillDirection;
    const recoveryOverride = advanceRecoveryOverrideRequest(req, direction, b, cur);
    if (recoveryOverride.present) {
      upd.advanceRecoveryOverrideAmount = recoveryOverride.amount;
      upd.advanceRecoveryOverrideReason = recoveryOverride.reason;
    }

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
    const contractIntegrityError = await ensureProjectContractSelection({
      companyId: cid,
      projectId: cur.projectId,
      direction,
      contractorId: finalContractorId,
      ownerContractId: upd.ownerContractId !== undefined ? upd.ownerContractId : cur.ownerContractId,
      subcontractorContractId: upd.subcontractorContractId !== undefined
        ? upd.subcontractorContractId
        : cur.subcontractorContractId,
    });
    if (contractIntegrityError) {
      res.status(400).json({ error: contractIntegrityError }); return;
    }
    const approvalOwnerContractId = upd.ownerContractId !== undefined ? upd.ownerContractId : cur.ownerContractId;
    const approvalSubcontractId = upd.subcontractorContractId !== undefined
      ? upd.subcontractorContractId
      : cur.subcontractorContractId;
    const executionRequested = [
      "progressPercent", "grossAmount", "retentionPercent", "retentionAmount",
      "dueAmount", "vatPercent", "vatAmount", "netAmount", "paidAmount",
    ].some((key) => b[key] !== undefined)
      || (b.status !== undefined && String(b.status) !== "draft");
    if (executionRequested) {
      const contractApprovalError = await ensureApprovedContract(
        cid,
        cur.projectId,
        direction,
        approvalOwnerContractId,
        approvalSubcontractId,
      );
      if (contractApprovalError) {
        res.status(422).json({ error: contractApprovalError }); return;
      }
    }

    const finalOwnerContractId = upd.ownerContractId !== undefined
      ? upd.ownerContractId
      : cur.ownerContractId;
    const finalSubcontractorContractId = upd.subcontractorContractId !== undefined
      ? upd.subcontractorContractId
      : cur.subcontractorContractId;
    const progressChanged = b.progressPercent !== undefined
      && numberChanged(b.progressPercent, cur.progressPercent);
    const contractChanged = numberChanged(finalOwnerContractId, cur.ownerContractId)
      || numberChanged(finalSubcontractorContractId, cur.subcontractorContractId);
    // Capture the policy when a draft first receives an exact contract link.
    // Existing drafts keep their original snapshot, so enabling recovery on a
    // contract cannot rewrite a legacy bill retroactively.
    const shouldSnapshotRecovery = contractChanged
      || (
        cur.ownerContractId == null
        && cur.subcontractorContractId == null
        && (finalOwnerContractId != null || finalSubcontractorContractId != null)
      );
    if (shouldSnapshotRecovery) {
      const recovery = await contractAdvanceRecoverySettings(
        cid,
        cur.projectId,
        direction,
        finalOwnerContractId ? Number(finalOwnerContractId) : null,
        finalSubcontractorContractId ? Number(finalSubcontractorContractId) : null,
      );
      upd.advanceRecoveryEnabled = recovery.enabled;
      upd.advanceRecoveryPercent = recovery.percent;
      upd.advanceRecoveryStartProgressPercent = recovery.startProgressPercent;
      upd.advanceRecoveryRequestedAmount = "0";
      upd.advanceRecoveryAmount = "0";
      upd.advanceRecoveryRemainingBefore = "0";
      upd.advanceRecoveryRemainingAfter = "0";
    }
    const shouldSnapshotRetention = contractChanged
      || (
        cur.ownerContractId == null
        && cur.subcontractorContractId == null
        && (finalOwnerContractId != null || finalSubcontractorContractId != null)
      );
    const retentionSnapshot = shouldSnapshotRetention
      ? await contractRetentionSettings(
        cid,
        cur.projectId,
        direction,
        finalOwnerContractId ? Number(finalOwnerContractId) : null,
        finalSubcontractorContractId ? Number(finalSubcontractorContractId) : null,
      )
      : null;
    if (shouldSnapshotRetention && !retentionSnapshot) {
      res.status(422).json({ error: "تعذر حفظ لقطة سياسة المحتجزات للعقد المرتبط" });
      return;
    }
    // A percentage change or a contract selection is a controlling aggregate
    // edit.  A marker without either change is intentionally ignored so a
    // legacy draft remains byte-for-byte compatible when merely renamed.
    const aggregateRequested = (b.aggregateProgress === true && (progressChanged || contractChanged))
      || progressChanged
      || contractChanged;
    if (aggregateRequested && await billHasDetailLines(cid, id)) {
      res.status(409).json({
        error: "هذا المستخلص تفصيلي ببنود كميات وأسعار؛ لا يمكن تعديل نسبة التجميع. عدّل بنود التفاصيل بدلاً من ذلك",
      });
      return;
    }

    let gross    = b.grossAmount      !== undefined ? Number(b.grossAmount)      : Number(cur.grossAmount);
    const hasRetentionEnabledPatch = b.retentionEnabled !== undefined && b.retentionEnabled !== null;
    const hasRetentionCapPatch = b.retentionCapPercent !== undefined && b.retentionCapPercent !== null;
    let retEnabled = shouldSnapshotRetention
      ? retentionSnapshot!.enabled
      : (hasRetentionEnabledPatch ? b.retentionEnabled === true : cur.retentionEnabled !== false);
    let retPct   = shouldSnapshotRetention
      ? Number(retentionSnapshot!.percent)
      : (b.retentionPercent !== undefined && b.retentionPercent !== null
        ? Number(b.retentionPercent)
        : Number(cur.retentionPercent));
    let retCapPct = shouldSnapshotRetention
      ? Number(retentionSnapshot!.capPercent)
      : (hasRetentionCapPatch
        ? Number(b.retentionCapPercent)
        : (cur.retentionCapPercent == null ? null : Number(cur.retentionCapPercent)));
    const retentionPercentError = validatePercentage(retPct, "نسبة المحتجزات");
    const retentionCapError = retCapPct == null ? null : validatePercentage(retCapPct, "سقف المحتجزات");
    if (retentionPercentError || retentionCapError) {
      res.status(400).json({ error: retentionPercentError || retentionCapError });
      return;
    }
    let prevPaid = b.previousPaid     !== undefined ? Number(b.previousPaid)     : Number(cur.previousPaid);
    // VAT % is now persisted on the bill row. If the client doesn't send a
    // new value we fall back to the stored value — never to a hard-coded
    // 15% — so editing a non-15% bill no longer silently rewrites its tax.
    const vatPct   = b.vatPercent       !== undefined ? Number(b.vatPercent)       : Number(cur.vatPercent ?? 15);
    upd.vatPercent = String(vatPct);
    const retentionCapBase = retCapPct == null
      || (finalOwnerContractId == null && finalSubcontractorContractId == null)
      ? null
      : await aggregateAdjustedContractValue(
        cid,
        cur.projectId,
        direction,
        finalOwnerContractId ? Number(finalOwnerContractId) : null,
        finalSubcontractorContractId ? Number(finalSubcontractorContractId) : null,
      );
    const requestedRetention = retEnabled
      ? Math.round((gross * retPct / 100) * 100) / 100
      : 0;
    const retentionCapAmount = retentionCapBase == null || retCapPct == null
      ? null
      : Math.round((retentionCapBase * retCapPct / 100) * 100) / 100;
    let retAmount = retentionCapAmount == null
      ? requestedRetention
      : Math.min(requestedRetention, retentionCapAmount);
    let dueAmount = Math.max(0, Math.round((gross - retAmount - prevPaid) * 100) / 100);
    let vatAmount = Math.round((dueAmount * vatPct / 100) * 100) / 100;
    let netAmount = Math.round((dueAmount + vatAmount) * 100) / 100;
    if (aggregateRequested) {
      const aggregate = await recomputeAggregateProgress({
        companyId: cid,
        projectId: cur.projectId,
        direction,
        contractorId: finalContractorId ? Number(finalContractorId) : null,
        ownerContractId: finalOwnerContractId ? Number(finalOwnerContractId) : null,
        subcontractorContractId: finalSubcontractorContractId ? Number(finalSubcontractorContractId) : null,
        progressPercent: b.progressPercent !== undefined ? b.progressPercent : cur.progressPercent,
        retentionEnabled: retEnabled,
        retentionPercent: retPct,
        retentionCapPercent: retCapPct,
        vatPercent: vatPct,
        excludeBillId: id,
      });
      gross = Number(aggregate.grossAmount);
      prevPaid = Number(aggregate.previousPaid);
      retAmount = Number(aggregate.retentionAmount);
      dueAmount = Number(aggregate.dueAmount);
      vatAmount = Number(aggregate.vatAmount);
      netAmount = Number(aggregate.netAmount);
    }
    upd.grossAmount      = String(gross);
    if (shouldSnapshotRetention || hasRetentionEnabledPatch) upd.retentionEnabled = retEnabled;
    upd.retentionPercent = String(retPct);
    if (shouldSnapshotRetention || hasRetentionCapPatch) {
      upd.retentionCapPercent = retCapPct == null ? null : String(retCapPct);
    }
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
  } catch (e: any) { res.status(Number(e?.status) || 500).json({ error: e?.message ?? "خطأ" }); }
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
    if (["approved", "posted", "partially_paid", "paid", "reversed"].includes(String(current.status)) || current.journalEntryId) {
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
