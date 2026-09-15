import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  db,
  contractingBillAttachmentsTable,
  contractingBillDeductionsTable,
  contractingBillLinesTable,
  contractingBillPenaltiesTable,
  contractingBillWorkflowEventsTable,
  contractingOwnerContractsTable,
  contractingProgressBillsTable,
  contractingProjectsTable,
  contractingSubContractsTable,
  contractingWorkItemsTable,
  journalEntriesTable,
} from "@workspace/db";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage.js";
import { canAccessModule } from "../middleware/permissions.js";
import { approveBill } from "./contracting-accounting-service.js";
import { contractingBranchAllowed } from "./contracting-security.js";
import type { AuthUser } from "../middleware/auth.js";

/**
 * Detail CRUD remains separate, but workflow approval delegates to the
 * accounting worker. This service never writes journal lines directly.
 */

const DEDUCTION_KINDS = new Set(["advance", "retention", "materials", "settlement", "other"]);
const ATTACHMENT_CATEGORIES = new Set(["invoice", "completion_certificate", "handover", "penalty", "other"]);
const WORKFLOW_STATES = new Set([
  "draft", "submitted", "under_review", "approved", "posted",
  "partially_paid", "paid", "rejected",
]);
const LOCKED_STATES = new Set(["approved", "posted", "partially_paid", "paid"]);

function error(message: string, status = 400): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

function numberValue(value: unknown, label: string, options: { integer?: boolean } = {}): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result) || result < 0 || (options.integer && !Number.isInteger(result))) {
    throw error(`${label} يجب أن يكون رقماً غير سالب`);
  }
  return result;
}

function money(value: number): string {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quantity(value: number): string {
  return (Math.round((value + Number.EPSILON) * 10000) / 10000).toFixed(4);
}

function idFrom(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw error(`${label} غير صالح`);
  return id;
}

function textValue(value: unknown, label: string, required = false): string | null {
  const result = value == null ? "" : String(value).trim();
  if (required && !result) throw error(`${label} مطلوب`);
  return result || null;
}

/**
 * These tables are deliberately created by the focused extension rather than
 * changing the worker-owned accounting router. CREATE IF NOT EXISTS makes this
 * safe for central and external-agent databases and for rolling upgrades.
 */
export function ensureContractingBillDetailsTables(): Promise<void> {
  return (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_bill_lines (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
        bill_id INTEGER NOT NULL REFERENCES contracting_progress_bills(id) ON DELETE CASCADE,
        work_item_id INTEGER REFERENCES contracting_work_items(id) ON DELETE SET NULL,
        previous_qty NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (previous_qty >= 0),
        current_qty NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (current_qty >= 0),
        cumulative_qty NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (cumulative_qty >= 0),
        previous_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (previous_value >= 0),
        current_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (current_value >= 0),
        cumulative_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cumulative_value >= 0),
        excess_approved BOOLEAN NOT NULL DEFAULT FALSE,
        excess_approval_reason TEXT,
        excess_approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        excess_approved_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, bill_id, work_item_id)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_lines_bill_idx
        ON contracting_bill_lines(company_id, bill_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_lines_work_item_idx
        ON contracting_bill_lines(company_id, project_id, work_item_id)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_bill_deductions (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
        bill_id INTEGER NOT NULL REFERENCES contracting_progress_bills(id) ON DELETE CASCADE,
        deduction_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('advance','retention','materials','settlement','other')),
        percentage NUMERIC(7,4),
        amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
        reason TEXT NOT NULL,
        reference TEXT,
        notes TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, bill_id, deduction_key)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_deductions_bill_idx
        ON contracting_bill_deductions(company_id, bill_id)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_bill_penalties (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
        bill_id INTEGER NOT NULL REFERENCES contracting_progress_bills(id) ON DELETE CASCADE,
        penalty_key TEXT NOT NULL,
        penalty_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
        penalty_date DATE NOT NULL,
        reference TEXT,
        notes TEXT,
        account_mapping_key TEXT,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, bill_id, penalty_key)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_penalties_bill_idx
        ON contracting_bill_penalties(company_id, bill_id)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_bill_attachments (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
        bill_id INTEGER NOT NULL REFERENCES contracting_progress_bills(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK (category IN ('invoice','completion_certificate','handover','penalty','other')),
        filename TEXT NOT NULL,
        object_path TEXT NOT NULL,
        content_type TEXT,
        bytes INTEGER,
        uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_attachments_bill_idx
        ON contracting_bill_attachments(company_id, bill_id)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS contracting_bill_workflow_events (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES contracting_projects(id) ON DELETE CASCADE,
        bill_id INTEGER NOT NULL REFERENCES contracting_progress_bills(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('draft','submitted','under_review','approved','posted','partially_paid','paid','rejected')),
        action TEXT NOT NULL,
        note TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_workflow_bill_idx
        ON contracting_bill_workflow_events(company_id, bill_id, created_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ctg_bill_workflow_project_idx
        ON contracting_bill_workflow_events(company_id, project_id, created_at DESC)
    `);
  })();
}

export function validateDeductionKind(value: unknown): string {
  const kind = String(value ?? "").trim();
  if (!DEDUCTION_KINDS.has(kind)) throw error("نوع الاستقطاع غير صالح");
  return kind;
}

export function validateAttachmentCategory(value: unknown): string {
  const category = String(value ?? "").trim();
  if (!ATTACHMENT_CATEGORIES.has(category)) throw error("نوع المرفق غير صالح");
  return category;
}

export function validateWorkflowState(value: unknown): string {
  const state = String(value ?? "").trim();
  if (!WORKFLOW_STATES.has(state)) throw error("حالة دورة المستخلص غير صالحة");
  return state;
}

type BranchUser = Pick<AuthUser, "id" | "role" | "viewAllBranches" | "branchIds">;

async function assertProjectBranchAccess(
  companyId: number,
  projectId: number,
  user: BranchUser | null | undefined,
) {
  const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
    .from(contractingProjectsTable)
    .where(and(
      eq(contractingProjectsTable.id, projectId),
      eq(contractingProjectsTable.companyId, companyId),
    ));
  if (!project) throw error("المشروع غير موجود", 404);
  if (!user) throw error("غير مصرح", 401);
  if (!contractingBranchAllowed(user, project.branchId)) {
    throw error("لا تملك صلاحية فرع المشروع", 403);
  }
  return project;
}

async function getBill(companyId: number, billId: number, user?: BranchUser | null) {
  const [bill] = await db.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  ));
  if (!bill) throw error("المستخلص غير موجود", 404);
  await assertProjectBranchAccess(companyId, bill.projectId, user);
  return bill;
}

async function getWorkflowState(companyId: number, bill: typeof contractingProgressBillsTable.$inferSelect): Promise<string> {
  const [event] = await db.select({ state: contractingBillWorkflowEventsTable.state })
    .from(contractingBillWorkflowEventsTable)
    .where(and(
      eq(contractingBillWorkflowEventsTable.companyId, companyId),
      eq(contractingBillWorkflowEventsTable.billId, bill.id),
    ))
    .orderBy(desc(contractingBillWorkflowEventsTable.createdAt), desc(contractingBillWorkflowEventsTable.id))
    .limit(1);
  if (event?.state) return event.state;
  // Preserve compatibility with documents created before this extension.
  if (bill.status === "partially_paid") return "partially_paid";
  if (bill.status === "paid") return "paid";
  if (bill.status === "approved") return "approved";
  if (bill.status === "posted") return "posted";
  if (bill.status === "under_review") return "under_review";
  if (bill.status === "submitted") return "submitted";
  if (bill.status === "rejected") return "rejected";
  return "draft";
}

async function assertEditable(companyId: number, billId: number, user?: BranchUser | null) {
  const bill = await getBill(companyId, billId, user);
  const state = await getWorkflowState(companyId, bill);
  if (LOCKED_STATES.has(state)) {
    throw error("المستخلص المرحّل أو المعتمد غير قابل للتعديل", 409);
  }
  return { bill, state };
}

async function logDetailAction(
  companyId: number,
  bill: typeof contractingProgressBillsTable.$inferSelect,
  action: string,
  userId: number | null | undefined,
  note?: string | null,
) {
  await db.insert(contractingBillWorkflowEventsTable).values({
    companyId,
    projectId: bill.projectId,
    billId: bill.id,
    state: await getWorkflowState(companyId, bill),
    action,
    note: note ?? null,
    userId: userId ?? null,
  });
}

async function assertProjectWorkItem(companyId: number, projectId: number, workItemId: number) {
  const [workItem] = await db.select().from(contractingWorkItemsTable).where(and(
    eq(contractingWorkItemsTable.id, workItemId),
    eq(contractingWorkItemsTable.companyId, companyId),
    eq(contractingWorkItemsTable.projectId, projectId),
  ));
  if (!workItem) throw error("بند التنفيذ غير صالح لهذا المشروع");
  return workItem;
}

async function priorTotals(
  companyId: number,
  projectId: number,
  workItemId: number,
  bill: typeof contractingProgressBillsTable.$inferSelect,
  excludeLineId?: number,
) {
  const rows = await db.select({
    line: contractingBillLinesTable,
    billDate: contractingProgressBillsTable.billDate,
    sourceBillId: contractingProgressBillsTable.id,
    direction: contractingProgressBillsTable.direction,
    ownerContractId: contractingProgressBillsTable.ownerContractId,
    subcontractorContractId: contractingProgressBillsTable.subcontractorContractId,
  }).from(contractingBillLinesTable).innerJoin(
    contractingProgressBillsTable,
    eq(contractingBillLinesTable.billId, contractingProgressBillsTable.id),
  ).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.projectId, projectId),
    eq(contractingBillLinesTable.workItemId, workItemId),
    eq(contractingProgressBillsTable.companyId, companyId),
    eq(contractingProgressBillsTable.projectId, projectId),
  ));

  let previousQty = 0;
  let previousValue = 0;
  for (const row of rows) {
    if (excludeLineId && row.line.id === excludeLineId) continue;
    // The bill number/id is the deterministic tie breaker for same-day bills.
    const before = String(row.billDate) < String(bill.billDate)
      || (String(row.billDate) === String(bill.billDate) && row.sourceBillId < bill.id);
    const sameContract = bill.direction === "incoming"
      ? !bill.subcontractorContractId || row.subcontractorContractId === bill.subcontractorContractId
      : !bill.ownerContractId || row.ownerContractId === bill.ownerContractId;
    if (row.sourceBillId !== bill.id && row.direction === bill.direction && sameContract && before) {
      previousQty += Number(row.line.currentQty);
      previousValue += Number(row.line.currentValue);
    }
  }
  return { previousQty, previousValue };
}

async function priorContractValue(
  companyId: number,
  bill: typeof contractingProgressBillsTable.$inferSelect,
  excludeLineId?: number,
) {
  const rows = await db.select({
    line: contractingBillLinesTable,
    billDate: contractingProgressBillsTable.billDate,
    sourceBillId: contractingProgressBillsTable.id,
    direction: contractingProgressBillsTable.direction,
    ownerContractId: contractingProgressBillsTable.ownerContractId,
    subcontractorContractId: contractingProgressBillsTable.subcontractorContractId,
  }).from(contractingBillLinesTable).innerJoin(
    contractingProgressBillsTable,
    eq(contractingBillLinesTable.billId, contractingProgressBillsTable.id),
  ).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.projectId, bill.projectId),
    eq(contractingProgressBillsTable.companyId, companyId),
    eq(contractingProgressBillsTable.projectId, bill.projectId),
  ));
  let total = 0;
  for (const row of rows) {
    if (excludeLineId && row.line.id === excludeLineId) continue;
    const sameContract = bill.direction === "incoming"
      ? !bill.subcontractorContractId || row.subcontractorContractId === bill.subcontractorContractId
      : !bill.ownerContractId || row.ownerContractId === bill.ownerContractId;
    if (row.sourceBillId === bill.id || row.direction !== bill.direction || !sameContract) continue;
    const before = String(row.billDate) < String(bill.billDate)
      || (String(row.billDate) === String(bill.billDate) && row.sourceBillId < bill.id);
    if (before) total += Number(row.line.currentValue);
  }
  // Include other allocations already added to this same draft bill. They
  // have no "previous" period but still count against the contract ceiling.
  return total + rows
    .filter((row) => {
      const sameContract = bill.direction === "incoming"
        ? !bill.subcontractorContractId || row.subcontractorContractId === bill.subcontractorContractId
        : !bill.ownerContractId || row.ownerContractId === bill.ownerContractId;
      return row.sourceBillId === bill.id && row.direction === bill.direction && sameContract
        && (!excludeLineId || row.line.id !== excludeLineId);
    })
    .reduce((sum, row) => sum + Number(row.line.currentValue), 0);
}

async function contractCeiling(companyId: number, bill: typeof contractingProgressBillsTable.$inferSelect) {
  if (bill.direction === "incoming" && bill.subcontractorContractId) {
    const [contract] = await db.select({ value: contractingSubContractsTable.value })
      .from(contractingSubContractsTable)
      .where(and(
        eq(contractingSubContractsTable.id, bill.subcontractorContractId),
        eq(contractingSubContractsTable.companyId, companyId),
        eq(contractingSubContractsTable.projectId, bill.projectId),
      ));
    return Number(contract?.value ?? 0);
  }
  if (bill.direction === "outgoing") {
    const contracts = await db.select({
      contractType: contractingOwnerContractsTable.contractType,
      value: contractingOwnerContractsTable.value,
    }).from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, bill.projectId),
    ));
    if (contracts.length > 0) {
      const main = contracts.find((contract) => contract.contractType === "main");
      return Number(main?.value ?? 0) + contracts
        .filter((contract) => contract.contractType === "change_order" || contract.contractType === "addendum")
        .reduce((sum, contract) => sum + Number(contract.value), 0);
    }
  }
  const [project] = await db.select({ contractValue: contractingProjectsTable.contractValue })
    .from(contractingProjectsTable).where(and(
      eq(contractingProjectsTable.id, bill.projectId),
      eq(contractingProjectsTable.companyId, companyId),
    ));
  return Number(project?.contractValue ?? 0);
}

async function enforceAllocationLimit(
  req: any,
  workItem: typeof contractingWorkItemsTable.$inferSelect,
  previousQty: number,
  currentQty: number,
  previousValue: number,
  currentValue: number,
  previousContractValue: number,
  contractValueLimit: number,
) {
  const cumulativeQty = previousQty + currentQty;
  const cumulativeValue = previousValue + currentValue;
  const plannedQty = Number(workItem.plannedQty);
  const declaredValue = Number(workItem.totalPlannedCost);
  const plannedValue = declaredValue > 0
    ? declaredValue
    : plannedQty > 0 ? plannedQty * Number(workItem.unitCost) : 0;
  const exceedsQty = plannedQty > 0 && cumulativeQty > plannedQty + 0.0001;
  const exceedsValue = plannedValue > 0 && cumulativeValue > plannedValue + 0.01;
  const exceedsContract = contractValueLimit > 0
    && previousContractValue + currentValue > contractValueLimit + 0.01;
  const approved = Boolean(req.body?.excessApproved || req.body?.overrideApproval);
  const reason = textValue(req.body?.excessApprovalReason ?? req.body?.approvalReason, "سبب اعتماد التجاوز");
  if ((exceedsQty || exceedsValue || exceedsContract) && (!approved || !reason)) {
    throw error("تجاوز الكمية أو قيمة العقد؛ يلزم اعتماد صريح وسبب وصلاحية اعتماد", 422);
  }
  if (approved && (exceedsQty || exceedsValue || exceedsContract) && !canAccessModule(req.authUser, "contracting", "post")) {
    throw error("لا تملك صلاحية اعتماد تجاوز الكمية أو قيمة العقد", 403);
  }
  return {
    cumulativeQty,
    cumulativeValue,
    approved: Boolean(approved && (exceedsQty || exceedsValue || exceedsContract)),
    reason,
  };
}

export async function listBillDetails(companyId: number, billId: number, user?: BranchUser | null) {
  const bill = await getBill(companyId, billId, user);
  const [lines, deductions, penalties, attachments, workflow, project, ownerContracts, subContracts] = await Promise.all([
    db.select({
      id: contractingBillLinesTable.id,
      projectId: contractingBillLinesTable.projectId,
      billId: contractingBillLinesTable.billId,
      workItemId: contractingBillLinesTable.workItemId,
      workItemName: contractingWorkItemsTable.nameAr,
      workItemCode: contractingWorkItemsTable.code,
      unit: contractingWorkItemsTable.unit,
      previousQty: contractingBillLinesTable.previousQty,
      currentQty: contractingBillLinesTable.currentQty,
      cumulativeQty: contractingBillLinesTable.cumulativeQty,
      previousValue: contractingBillLinesTable.previousValue,
      currentValue: contractingBillLinesTable.currentValue,
      cumulativeValue: contractingBillLinesTable.cumulativeValue,
      excessApproved: contractingBillLinesTable.excessApproved,
      excessApprovalReason: contractingBillLinesTable.excessApprovalReason,
      excessApprovedByUserId: contractingBillLinesTable.excessApprovedByUserId,
      excessApprovedAt: contractingBillLinesTable.excessApprovedAt,
      createdAt: contractingBillLinesTable.createdAt,
      updatedAt: contractingBillLinesTable.updatedAt,
    }).from(contractingBillLinesTable).leftJoin(
      contractingWorkItemsTable,
      and(
        eq(contractingBillLinesTable.workItemId, contractingWorkItemsTable.id),
        eq(contractingWorkItemsTable.companyId, companyId),
      ),
    ).where(and(eq(contractingBillLinesTable.companyId, companyId), eq(contractingBillLinesTable.billId, billId)))
      .orderBy(contractingBillLinesTable.id),
    db.select().from(contractingBillDeductionsTable)
      .where(and(eq(contractingBillDeductionsTable.companyId, companyId), eq(contractingBillDeductionsTable.billId, billId)))
      .orderBy(contractingBillDeductionsTable.id),
    db.select().from(contractingBillPenaltiesTable)
      .where(and(eq(contractingBillPenaltiesTable.companyId, companyId), eq(contractingBillPenaltiesTable.billId, billId)))
      .orderBy(contractingBillPenaltiesTable.id),
    db.select().from(contractingBillAttachmentsTable)
      .where(and(eq(contractingBillAttachmentsTable.companyId, companyId), eq(contractingBillAttachmentsTable.billId, billId)))
      .orderBy(desc(contractingBillAttachmentsTable.createdAt)),
    db.select().from(contractingBillWorkflowEventsTable)
      .where(and(eq(contractingBillWorkflowEventsTable.companyId, companyId), eq(contractingBillWorkflowEventsTable.billId, billId)))
      .orderBy(desc(contractingBillWorkflowEventsTable.createdAt), desc(contractingBillWorkflowEventsTable.id)),
    db.select({ contractValue: contractingProjectsTable.contractValue })
      .from(contractingProjectsTable)
      .where(and(eq(contractingProjectsTable.id, bill.projectId), eq(contractingProjectsTable.companyId, companyId))),
    db.select().from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.companyId, companyId),
      eq(contractingOwnerContractsTable.projectId, bill.projectId),
    )),
    db.select().from(contractingSubContractsTable).where(and(
      eq(contractingSubContractsTable.companyId, companyId),
      eq(contractingSubContractsTable.projectId, bill.projectId),
    )),
  ]);
  const state = await getWorkflowState(companyId, bill);
  const retention = Number(bill.retentionAmount ?? 0);
  const extensionDeductions = deductions
    .filter((row) => !["retention", "advance", "settlement"].includes(row.kind))
    .reduce((total, row) => total + Number(row.amount), 0);
  const deductionsTotal = retention + extensionDeductions;
  const netBeforeTax = Math.max(0, Number(bill.grossAmount) - deductionsTotal - Number(bill.previousPaid));
  const selectedOwner = ownerContracts.find((contract) => contract.id === bill.ownerContractId);
  const selectedSub = subContracts.find((contract) => contract.id === bill.subcontractorContractId);
  const mainOwner = ownerContracts.find((contract) => contract.contractType === "main");
  const originalContractValue = bill.direction === "incoming"
    ? Number(selectedSub?.value ?? 0)
    : Number(mainOwner?.value ?? selectedOwner?.value ?? project[0]?.contractValue ?? 0);
  const changeOrdersValue = bill.direction === "incoming"
    ? 0
    : ownerContracts
      .filter((contract) => contract.contractType === "change_order" || contract.contractType === "addendum")
      .reduce((total, contract) => total + Number(contract.value), 0);
  const adjustedContractValue = originalContractValue + changeOrdersValue;
  const cumulativeWorks = lines.length > 0
    ? lines.reduce((total, row) => total + Number(row.cumulativeValue), 0)
    : Number(bill.grossAmount);
  const currentWorks = lines.length > 0
    ? lines.reduce((total, row) => total + Number(row.currentValue), 0)
    : Number(bill.grossAmount);
  return {
    bill: {
      id: bill.id,
      projectId: bill.projectId,
      direction: bill.direction,
      grossAmount: bill.grossAmount,
      retentionAmount: bill.retentionAmount,
      previousPaid: bill.previousPaid,
      vatPercent: bill.vatPercent,
      vatAmount: bill.vatAmount,
      netAmount: bill.netAmount,
      paidAmount: bill.paidAmount,
      status: bill.status,
    },
    state,
    lines,
    deductions,
    penalties,
    attachments,
    workflow,
    summary: {
      grossWorks: Number(bill.grossAmount),
      previousWorks: lines.reduce((total, row) => total + Number(row.previousValue), 0),
      currentWorks,
      cumulativeWorks,
      originalContractValue,
      changeOrdersValue,
      adjustedContractValue,
      remainingContractValue: Math.max(0, adjustedContractValue - cumulativeWorks),
      cumulativeCompletionPercent: adjustedContractValue > 0
        ? Math.min(100, cumulativeWorks / adjustedContractValue * 100)
        : 0,
      deductionsTotal,
      retentionAmount: retention,
      penaltyTotal: penalties.reduce((total, row) => total + Number(row.amount), 0),
      netBeforeTax,
      vatAmount: Number(bill.vatAmount), // Reuse the existing VAT result; deductions never imply a VAT deduction.
      netAmount: Number(bill.netAmount),
      paidAmount: Number(bill.paidAmount),
      remainingAmount: Math.max(0, Number(bill.netAmount) - Number(bill.paidAmount)),
    },
  };
}

export async function createBillLine(companyId: number, billId: number, req: any) {
  const { bill } = await assertEditable(companyId, billId, req.authUser);
  const workItemId = idFrom(req.body?.workItemId, "بند التنفيذ");
  const [duplicate] = await db.select({ id: contractingBillLinesTable.id }).from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.billId, billId),
    eq(contractingBillLinesTable.workItemId, workItemId),
  ));
  if (duplicate) throw error("لا يمكن إضافة بند التنفيذ نفسه مرتين إلى المستخلص", 409);
  const workItem = await assertProjectWorkItem(companyId, bill.projectId, workItemId);
  const currentQty = numberValue(req.body?.currentQty, "الكمية الحالية");
  const currentValue = numberValue(req.body?.currentValue, "قيمة الأعمال الحالية");
  const previous = await priorTotals(companyId, bill.projectId, workItemId, bill);
  const previousContractValue = await priorContractValue(companyId, bill);
  const limits = await enforceAllocationLimit(
    req, workItem, previous.previousQty, currentQty, previous.previousValue, currentValue,
    previousContractValue, await contractCeiling(companyId, bill),
  );
  const [row] = await db.insert(contractingBillLinesTable).values({
    companyId,
    projectId: bill.projectId,
    billId,
    workItemId,
    previousQty: quantity(previous.previousQty),
    currentQty: quantity(currentQty),
    cumulativeQty: quantity(limits.cumulativeQty),
    previousValue: money(previous.previousValue),
    currentValue: money(currentValue),
    cumulativeValue: money(limits.cumulativeValue),
    excessApproved: limits.approved,
    excessApprovalReason: limits.approved ? limits.reason : null,
    excessApprovedByUserId: limits.approved ? req.authUser?.id ?? null : null,
    excessApprovedAt: limits.approved ? new Date() : null,
  }).returning();
  if (limits.approved) {
    await logDetailAction(companyId, bill, "excess_approved", req.authUser?.id, limits.reason);
  }
  await logDetailAction(companyId, bill, "line_created", req.authUser?.id);
  return row;
}

export async function updateBillLine(companyId: number, lineId: number, req: any) {
  const [existing] = await db.select().from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.id, lineId),
    eq(contractingBillLinesTable.companyId, companyId),
  ));
  if (!existing) throw error("بند المستخلص غير موجود", 404);
  const { bill } = await assertEditable(companyId, existing.billId, req.authUser);
  const workItemId = req.body?.workItemId == null ? existing.workItemId : idFrom(req.body.workItemId, "بند التنفيذ");
  if (!workItemId) throw error("بند التنفيذ مطلوب");
  const [duplicate] = await db.select({ id: contractingBillLinesTable.id }).from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.companyId, companyId),
    eq(contractingBillLinesTable.billId, existing.billId),
    eq(contractingBillLinesTable.workItemId, workItemId),
  ));
  if (duplicate && duplicate.id !== existing.id) throw error("لا يمكن تكرار بند التنفيذ في المستخلص", 409);
  const workItem = await assertProjectWorkItem(companyId, bill.projectId, workItemId);
  const currentQty = req.body?.currentQty === undefined ? Number(existing.currentQty) : numberValue(req.body.currentQty, "الكمية الحالية");
  const currentValue = req.body?.currentValue === undefined ? Number(existing.currentValue) : numberValue(req.body.currentValue, "قيمة الأعمال الحالية");
  const previous = await priorTotals(companyId, bill.projectId, workItemId, bill, existing.id);
  const previousContractValue = await priorContractValue(companyId, bill, existing.id);
  const limits = await enforceAllocationLimit(
    req, workItem, previous.previousQty, currentQty, previous.previousValue, currentValue,
    previousContractValue, await contractCeiling(companyId, bill),
  );
  const [row] = await db.update(contractingBillLinesTable).set({
    workItemId,
    previousQty: quantity(previous.previousQty),
    currentQty: quantity(currentQty),
    cumulativeQty: quantity(limits.cumulativeQty),
    previousValue: money(previous.previousValue),
    currentValue: money(currentValue),
    cumulativeValue: money(limits.cumulativeValue),
    excessApproved: limits.approved,
    excessApprovalReason: limits.approved ? limits.reason : null,
    excessApprovedByUserId: limits.approved ? req.authUser?.id ?? null : null,
    excessApprovedAt: limits.approved ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingBillLinesTable.id, lineId),
    eq(contractingBillLinesTable.companyId, companyId),
  )).returning();
  await logDetailAction(companyId, bill, "line_updated", req.authUser?.id);
  return row;
}

export async function deleteBillLine(companyId: number, lineId: number, user?: BranchUser | null) {
  const [line] = await db.select().from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.id, lineId),
    eq(contractingBillLinesTable.companyId, companyId),
  ));
  if (!line) throw error("بند المستخلص غير موجود", 404);
  const { bill } = await assertEditable(companyId, line.billId, user);
  await db.delete(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.id, lineId),
    eq(contractingBillLinesTable.companyId, companyId),
  ));
  await logDetailAction(companyId, bill, "line_deleted", user?.id);
  return { ok: true };
}

export async function createBillDeduction(companyId: number, billId: number, req: any) {
  const { bill } = await assertEditable(companyId, billId, req.authUser);
  const kind = validateDeductionKind(req.body?.kind);
  const key = textValue(req.body?.deductionKey, "مفتاح الاستقطاع", true)!;
  const [duplicate] = await db.select({ id: contractingBillDeductionsTable.id }).from(contractingBillDeductionsTable).where(and(
    eq(contractingBillDeductionsTable.companyId, companyId),
    eq(contractingBillDeductionsTable.billId, billId),
    eq(contractingBillDeductionsTable.deductionKey, key),
  ));
  if (duplicate) throw error("مفتاح الاستقطاع مستخدم مسبقاً", 409);
  const reason = textValue(req.body?.reason, "سبب الاستقطاع", true)!;
  const amount = numberValue(req.body?.amount, "قيمة الاستقطاع");
  const percentage = req.body?.percentage === undefined || req.body?.percentage === null || req.body?.percentage === ""
    ? null
    : numberValue(req.body.percentage, "نسبة الاستقطاع");
  if (percentage != null && percentage > 100) throw error("نسبة الاستقطاع لا تتجاوز 100");
  const [row] = await db.insert(contractingBillDeductionsTable).values({
    companyId, projectId: bill.projectId, billId,
    deductionKey: key, kind, percentage: percentage == null ? null : String(percentage),
    amount: money(amount), reason,
    reference: textValue(req.body?.reference, "المرجع"),
    notes: textValue(req.body?.notes, "الملاحظات"),
    createdByUserId: req.authUser?.id ?? null,
  }).returning();
  await logDetailAction(companyId, bill, "deduction_created", req.authUser?.id, reason);
  return row;
}

export async function updateBillDeduction(companyId: number, id: number, req: any) {
  const [existing] = await db.select().from(contractingBillDeductionsTable).where(and(
    eq(contractingBillDeductionsTable.id, id),
    eq(contractingBillDeductionsTable.companyId, companyId),
  ));
  if (!existing) throw error("الاستقطاع غير موجود", 404);
  const { bill } = await assertEditable(companyId, existing.billId, req.authUser);
  const kind = req.body?.kind === undefined ? existing.kind : validateDeductionKind(req.body.kind);
  const amount = req.body?.amount === undefined ? Number(existing.amount) : numberValue(req.body.amount, "قيمة الاستقطاع");
  const percentage = req.body?.percentage === undefined
    ? existing.percentage == null ? null : Number(existing.percentage)
    : req.body.percentage === null || req.body.percentage === "" ? null : numberValue(req.body.percentage, "نسبة الاستقطاع");
  if (percentage != null && percentage > 100) throw error("نسبة الاستقطاع لا تتجاوز 100");
  const reason = req.body?.reason === undefined ? existing.reason : textValue(req.body.reason, "سبب الاستقطاع", true)!;
  const [row] = await db.update(contractingBillDeductionsTable).set({
    kind,
    amount: money(amount),
    percentage: percentage == null ? null : String(percentage),
    reason,
    reference: req.body?.reference === undefined ? existing.reference : textValue(req.body.reference, "المرجع"),
    notes: req.body?.notes === undefined ? existing.notes : textValue(req.body.notes, "الملاحظات"),
    updatedAt: new Date(),
  }).where(and(eq(contractingBillDeductionsTable.id, id), eq(contractingBillDeductionsTable.companyId, companyId))).returning();
  await logDetailAction(companyId, bill, "deduction_updated", req.authUser?.id);
  return row;
}

export async function deleteBillDeduction(companyId: number, id: number, user?: BranchUser | null) {
  const [existing] = await db.select().from(contractingBillDeductionsTable).where(and(
    eq(contractingBillDeductionsTable.id, id),
    eq(contractingBillDeductionsTable.companyId, companyId),
  ));
  if (!existing) throw error("الاستقطاع غير موجود", 404);
  const { bill } = await assertEditable(companyId, existing.billId, user);
  await db.delete(contractingBillDeductionsTable).where(and(eq(contractingBillDeductionsTable.id, id), eq(contractingBillDeductionsTable.companyId, companyId)));
  await logDetailAction(companyId, bill, "deduction_deleted", user?.id);
  return { ok: true };
}

export async function createBillPenalty(companyId: number, billId: number, req: any) {
  const { bill } = await assertEditable(companyId, billId, req.authUser);
  const key = textValue(req.body?.penaltyKey, "مفتاح الغرامة", true)!;
  const [duplicate] = await db.select({ id: contractingBillPenaltiesTable.id }).from(contractingBillPenaltiesTable).where(and(
    eq(contractingBillPenaltiesTable.companyId, companyId),
    eq(contractingBillPenaltiesTable.billId, billId),
    eq(contractingBillPenaltiesTable.penaltyKey, key),
  ));
  if (duplicate) throw error("مفتاح الغرامة مستخدم مسبقاً", 409);
  const penaltyType = textValue(req.body?.penaltyType, "نوع الغرامة", true)!;
  const reason = textValue(req.body?.reason, "سبب الغرامة", true)!;
  const amount = numberValue(req.body?.amount, "قيمة الغرامة");
  const penaltyDate = textValue(req.body?.penaltyDate, "تاريخ الغرامة", true)!;
  const [row] = await db.insert(contractingBillPenaltiesTable).values({
    companyId, projectId: bill.projectId, billId,
    penaltyKey: key, penaltyType, reason, amount: money(amount), penaltyDate,
    reference: textValue(req.body?.reference, "المرجع"),
    notes: textValue(req.body?.notes, "الملاحظات"),
    accountMappingKey: textValue(req.body?.accountMappingKey, "مفتاح الحساب"),
    createdByUserId: req.authUser?.id ?? null,
  }).returning();
  await logDetailAction(companyId, bill, "penalty_created", req.authUser?.id, reason);
  return row;
}

export async function updateBillPenalty(companyId: number, id: number, req: any) {
  const [existing] = await db.select().from(contractingBillPenaltiesTable).where(and(
    eq(contractingBillPenaltiesTable.id, id),
    eq(contractingBillPenaltiesTable.companyId, companyId),
  ));
  if (!existing) throw error("الغرامة غير موجودة", 404);
  const { bill } = await assertEditable(companyId, existing.billId, req.authUser);
  const [row] = await db.update(contractingBillPenaltiesTable).set({
    penaltyType: req.body?.penaltyType === undefined ? existing.penaltyType : textValue(req.body.penaltyType, "نوع الغرامة", true)!,
    reason: req.body?.reason === undefined ? existing.reason : textValue(req.body.reason, "سبب الغرامة", true)!,
    amount: req.body?.amount === undefined ? existing.amount : money(numberValue(req.body.amount, "قيمة الغرامة")),
    penaltyDate: req.body?.penaltyDate === undefined ? existing.penaltyDate : textValue(req.body.penaltyDate, "تاريخ الغرامة", true)!,
    reference: req.body?.reference === undefined ? existing.reference : textValue(req.body.reference, "المرجع"),
    notes: req.body?.notes === undefined ? existing.notes : textValue(req.body.notes, "الملاحظات"),
    accountMappingKey: req.body?.accountMappingKey === undefined ? existing.accountMappingKey : textValue(req.body.accountMappingKey, "مفتاح الحساب"),
    updatedAt: new Date(),
  }).where(and(eq(contractingBillPenaltiesTable.id, id), eq(contractingBillPenaltiesTable.companyId, companyId))).returning();
  await logDetailAction(companyId, bill, "penalty_updated", req.authUser?.id);
  return row;
}

export async function deleteBillPenalty(companyId: number, id: number, user?: BranchUser | null) {
  const [existing] = await db.select().from(contractingBillPenaltiesTable).where(and(
    eq(contractingBillPenaltiesTable.id, id),
    eq(contractingBillPenaltiesTable.companyId, companyId),
  ));
  if (!existing) throw error("الغرامة غير موجودة", 404);
  const { bill } = await assertEditable(companyId, existing.billId, user);
  await db.delete(contractingBillPenaltiesTable).where(and(eq(contractingBillPenaltiesTable.id, id), eq(contractingBillPenaltiesTable.companyId, companyId)));
  await logDetailAction(companyId, bill, "penalty_deleted", user?.id);
  return { ok: true };
}

function safeObjectPath(value: unknown): string {
  const path = String(value ?? "").trim();
  // Only the existing private object-entity convention is accepted. In
  // particular, http(s) URLs are never fetched or persisted.
  if (!/^\/objects\/[A-Za-z0-9/_\-.]+$/.test(path) || path.includes("..")) {
    throw error("مرجع المرفق يجب أن يكون مسار تخزين كائني داخلياً");
  }
  return path;
}

const BILL_ATTACHMENT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function billAttachmentObjectPath(companyId: number, billId: number, userId: number, token: string): string {
  if (!BILL_ATTACHMENT_TOKEN.test(token)) throw error("رمز رفع المرفق غير صالح", 400);
  return `/objects/contracting-bills/company-${companyId}/bill-${billId}/uploader-${userId}/${token}`;
}

function validateBillAttachmentObjectPath(
  companyId: number,
  billId: number,
  userId: number,
  value: unknown,
): string {
  const path = safeObjectPath(value);
  const prefix = `/objects/contracting-bills/company-${companyId}/bill-${billId}/uploader-${userId}/`;
  if (!path.startsWith(prefix) || !BILL_ATTACHMENT_TOKEN.test(path.slice(prefix.length))) {
    throw error("يجب استخدام ملف مرفوع من خلال مساحة مرفقات هذا المستخلص", 422);
  }
  return path;
}

export async function requestBillAttachmentUpload(companyId: number, billId: number, req: any) {
  const { bill } = await assertEditable(companyId, billId, req.authUser);
  const userId = idFrom(req.authUser?.id, "المستخدم");
  const size = Number(req.body?.size);
  const contentType = textValue(req.body?.contentType, "نوع الملف", true)!;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 50 * 1024 * 1024) {
    throw error("حجم الملف يجب أن يكون بين 1 بايت و50 ميغابايت", 422);
  }
  const token = randomUUID();
  const objectPath = billAttachmentObjectPath(companyId, bill.id, userId, token);
  const relativeKey = objectPath.slice("/objects/".length);
  const storage = new ObjectStorageService();
  if (storage.usesLocalPrivateStorage()) {
    const uploadURL = `${req.baseUrl}/bills/${billId}/attachments/upload-direct/${token}`
      + `?size=${size}&contentType=${encodeURIComponent(contentType)}`;
    return { uploadURL, objectPath, direct: true, metadata: { size, contentType } };
  }
  const target = await storage.getPrivateUploadTarget(relativeKey, { sizeBytes: size });
  return { ...target, direct: false, metadata: { size, contentType } };
}

export async function writeBillAttachmentDirect(companyId: number, billId: number, token: string, req: any) {
  const { bill } = await assertEditable(companyId, billId, req.authUser);
  const userId = idFrom(req.authUser?.id, "المستخدم");
  const objectPath = billAttachmentObjectPath(companyId, bill.id, userId, token);
  const expectedSize = Number(req.query?.size);
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const declaredSize = Number(req.headers["x-zacod-upload-size"]);
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize !== bytes.length
    || !Number.isSafeInteger(declaredSize) || declaredSize !== bytes.length) {
    throw error("حجم الملف لا يطابق طلب الرفع", 400);
  }
  const contentType = textValue(req.query?.contentType, "نوع الملف") ?? "application/octet-stream";
  const storage = new ObjectStorageService();
  if (!storage.usesLocalPrivateStorage()) throw error("الرفع المباشر متاح للوكلاء المحليين فقط", 404);
  const file = storage.getPrivateObjectFile(objectPath.slice("/objects/".length));
  const stream = file.createWriteStream({
    metadata: { contentType, cacheControl: "private, no-store" },
  });
  stream.end(bytes);
  await once(stream, "finish");
  return { objectPath };
}

export async function downloadBillAttachment(
  companyId: number,
  billId: number,
  attachmentId: number,
  user?: BranchUser | null,
) {
  const bill = await getBill(companyId, billId, user);
  const [attachment] = await db.select().from(contractingBillAttachmentsTable).where(and(
    eq(contractingBillAttachmentsTable.id, attachmentId),
    eq(contractingBillAttachmentsTable.companyId, companyId),
    eq(contractingBillAttachmentsTable.billId, bill.id),
  ));
  if (!attachment) throw error("المرفق غير موجود", 404);
  const userId = Number(attachment.uploadedByUserId);
  if (!Number.isInteger(userId) || userId <= 0) throw error("مرجع المرفق غير صالح", 422);
  const objectPath = validateBillAttachmentObjectPath(companyId, bill.id, userId, attachment.objectPath);
  const storage = new ObjectStorageService();
  try {
    const file = await storage.getObjectEntityFile(objectPath);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return storage.downloadObject(file, 0);
  } catch (caught) {
    if (caught instanceof ObjectNotFoundError) throw error("الملف غير موجود في التخزين", 404);
    throw caught;
  }
}

export async function createBillAttachment(companyId: number, billId: number, req: any) {
  const { bill } = await assertEditable(companyId, billId, req.authUser);
  const category = validateAttachmentCategory(req.body?.category);
  const userId = idFrom(req.authUser?.id, "المستخدم");
  const objectPath = validateBillAttachmentObjectPath(companyId, bill.id, userId, req.body?.objectPath);
  const filename = textValue(req.body?.filename, "اسم الملف", true)!;
  if (filename.length > 255) throw error("اسم الملف طويل");
  const storage = new ObjectStorageService();
  try {
    const object = await storage.getObjectEntityFile(objectPath);
    const [exists] = await object.exists();
    if (!exists) throw new ObjectNotFoundError();
    const [metadata] = await object.getMetadata();
    const [row] = await db.insert(contractingBillAttachmentsTable).values({
      companyId, projectId: bill.projectId, billId, category, filename,
      objectPath,
      contentType: textValue(req.body?.contentType, "نوع الملف") ?? String(metadata.contentType ?? "application/octet-stream"),
      bytes: Number(metadata.size ?? req.body?.bytes ?? 0) || null,
      uploadedByUserId: req.authUser?.id ?? null,
    }).returning();
    await logDetailAction(companyId, bill, "attachment_created", req.authUser?.id, category);
    return row;
  } catch (caught) {
    if (caught instanceof ObjectNotFoundError) throw error("الملف غير موجود في التخزين؛ ارفع الملف أولاً", 422);
    throw caught;
  }
}

export async function deleteBillAttachment(companyId: number, id: number, user?: BranchUser | null) {
  const [existing] = await db.select().from(contractingBillAttachmentsTable).where(and(
    eq(contractingBillAttachmentsTable.id, id),
    eq(contractingBillAttachmentsTable.companyId, companyId),
  ));
  if (!existing) throw error("المرفق غير موجود", 404);
  const { bill } = await assertEditable(companyId, existing.billId, user);
  await db.delete(contractingBillAttachmentsTable).where(and(eq(contractingBillAttachmentsTable.id, id), eq(contractingBillAttachmentsTable.companyId, companyId)));
  await logDetailAction(companyId, bill, "attachment_deleted", user?.id);
  return { ok: true };
}

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(["submitted", "rejected"]),
  submitted: new Set(["under_review", "rejected"]),
  under_review: new Set(["approved", "rejected"]),
  approved: new Set(["posted", "rejected"]),
  posted: new Set(["partially_paid", "paid"]),
  partially_paid: new Set(["paid"]),
  paid: new Set(),
  rejected: new Set(["draft", "submitted"]),
};

export async function transitionBillWorkflow(companyId: number, billId: number, req: any) {
  const bill = await getBill(companyId, billId, req.authUser);
  const current = await getWorkflowState(companyId, bill);
  const next = validateWorkflowState(req.body?.state);
  if (current === next) {
    if (["approved", "posted", "partially_paid", "paid"].includes(current)) {
      if (!bill.journalEntryId || !["approved", "posted", "partially_paid", "paid"].includes(String(bill.status))) {
        throw error("حالة المستخلص المالية موجودة بلا قيد محاسبي مرحّل؛ استخدم مسار الاعتماد المحاسبي", 409);
      }
      const [journal] = await db.select({ status: journalEntriesTable.status })
        .from(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.id, Number(bill.journalEntryId)),
          eq(journalEntriesTable.companyId, companyId),
        ));
      if (!journal || journal.status !== "posted") {
        throw error("حالة المستخلص المالية مرتبطة بقيد غير مرحّل؛ راجع المحاسبة", 409);
      }
    }
    return { state: current, idempotent: true };
  }
  if (!ALLOWED_TRANSITIONS[current]?.has(next)) {
    throw error(`لا يمكن نقل المستخلص من ${current} إلى ${next}`, 409);
  }
  if (next === "rejected" && ["approved", "posted", "partially_paid", "paid"].includes(current)) {
    throw error("لا يمكن رفض مستخلص بعد إنشاء قيده المحاسبي؛ استخدم فك الاعتماد المصرح به", 409);
  }
  // Approval is never a detail-only workflow transition: delegate to the
  // accounting owner so `approved` can only exist with a posted JE. The
  // accounting path also writes the immutable approval workflow event.
  if (next === "approved") {
    const accounting = await approveBill({
      companyId,
      billId,
      userId: req.authUser?.id ?? null,
      req,
    });
    return { state: "approved", accounting };
  }
  if (next === "posted") {
    if (bill.status !== "approved" || !bill.journalEntryId) {
      throw error("لا يمكن ترحيل المستخلص قبل إنشاء قيد محاسبي مرحّل", 409);
    }
    const [journal] = await db.select({ status: journalEntriesTable.status })
      .from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.id, Number(bill.journalEntryId)),
        eq(journalEntriesTable.companyId, companyId),
      ));
    if (!journal || journal.status !== "posted") {
      throw error("قيد المستخلص غير مرحّل؛ لا يمكن نقل الحالة إلى مرحّل", 409);
    }
  }
  if (next === "partially_paid" || next === "paid") {
    if (!bill.journalEntryId || bill.status !== "approved" && bill.status !== "posted") {
      throw error("لا يمكن تسجيل السداد قبل وجود قيد محاسبي مرحّل", 409);
    }
    const [journal] = await db.select({ status: journalEntriesTable.status })
      .from(journalEntriesTable)
      .where(and(
        eq(journalEntriesTable.id, Number(bill.journalEntryId)),
        eq(journalEntriesTable.companyId, companyId),
      ));
    if (!journal || journal.status !== "posted") {
      throw error("لا يمكن تسجيل السداد قبل ترحيل قيد المستخلص", 409);
    }
    const paidResult = await db.execute(sql`
      SELECT COALESCE(SUM(amount) FILTER (
        WHERE kind IN ('bill_receipt','bill_payment','advance_application')
      ), 0)::numeric AS paid
        FROM contracting_accounting_settlements
       WHERE company_id = ${companyId}
         AND bill_id = ${billId}
         AND status = 'posted'
    `);
    const paidRows = Array.isArray(paidResult) ? paidResult : (paidResult as any).rows ?? [];
    const settled = Number(paidRows[0]?.paid ?? 0);
    const adjustmentResult = await db.execute(sql`
      SELECT
        COALESCE((
          SELECT SUM(amount)
            FROM contracting_bill_deductions
           WHERE company_id = ${companyId}
             AND bill_id = ${billId}
             AND kind IN ('materials','other')
        ), 0)
        + COALESCE((
          SELECT SUM(amount)
            FROM contracting_bill_penalties
           WHERE company_id = ${companyId}
             AND bill_id = ${billId}
        ), 0) AS applied
    `);
    const adjustmentRows = Array.isArray(adjustmentResult)
      ? adjustmentResult
      : (adjustmentResult as any).rows ?? [];
    const appliedAdjustments = Number(adjustmentRows[0]?.applied ?? 0);
    const paid = Math.max(Number(bill.paidAmount), settled) + appliedAdjustments;
    if (!(paid > 0) || (next === "paid" && paid + 0.005 < Number(bill.netAmount))) {
      throw error(next === "paid" ? "لا يمكن إغلاق المستخلص قبل سداد صافي المبلغ" : "لا يوجد سداد محاسبي مسجل للمستخلص", 409);
    }
  }
  const [event] = await db.transaction(async (tx) => {
    if (next !== "approved") {
      await tx.update(contractingProgressBillsTable).set({
        status: next,
        paidAt: next === "paid" ? new Date() : undefined,
        updatedAt: new Date(),
      }).where(and(
        eq(contractingProgressBillsTable.id, billId),
        eq(contractingProgressBillsTable.companyId, companyId),
      ));
    }
    return tx.insert(contractingBillWorkflowEventsTable).values({
      companyId, projectId: bill.projectId, billId,
      state: next,
      action: `transition_${next}`,
      note: textValue(req.body?.note, "الملاحظات"),
      userId: req.authUser?.id ?? null,
    }).returning();
  });
  return { state: next, event };
}

async function settlementTotals(companyId: number) {
  try {
    const result = await db.execute(sql`
      SELECT bill_id,
             COALESCE(SUM(amount) FILTER (
               WHERE kind IN ('bill_receipt','bill_payment','advance_application')
             ), 0)::numeric AS paid
        FROM contracting_accounting_settlements
       WHERE company_id = ${companyId}
         AND bill_id IS NOT NULL
       GROUP BY bill_id
    `);
    const rows = ((result as any).rows ?? result) as Array<{ bill_id: number | string; paid: string | number }>;
    return new Map(rows.map((row) => [Number(row.bill_id), Number(row.paid)]));
  } catch {
    // The accounting worker may not have created its optional table yet.
    return new Map<number, number>();
  }
}

export async function contractingBillsReport(
  companyId: number,
  filters: { projectId?: number; direction?: string } = {},
  user?: BranchUser | null,
) {
  if (!user) throw error("غير مصرح", 401);
  const scopedProjects = await db.select({
    id: contractingProjectsTable.id,
    branchId: contractingProjectsTable.branchId,
  }).from(contractingProjectsTable).where(eq(contractingProjectsTable.companyId, companyId));
  const allowedProjectIds = scopedProjects
    .filter((project) => contractingBranchAllowed(user, project.branchId))
    .map((project) => project.id);
  if (filters.projectId && !allowedProjectIds.includes(filters.projectId)) {
    return {
      bills: [],
      totals: {
        grossWorks: 0, previousWorks: 0, currentWorks: 0, cumulativeWorks: 0,
        deductions: 0, retentions: 0, penalties: 0, payments: 0, outstanding: 0,
        contractValue: 0, remainingContract: 0, completionPercent: 0,
      },
    };
  }
  if (allowedProjectIds.length === 0) {
    return {
      bills: [],
      totals: {
        grossWorks: 0, previousWorks: 0, currentWorks: 0, cumulativeWorks: 0,
        deductions: 0, retentions: 0, penalties: 0, payments: 0, outstanding: 0,
        contractValue: 0, remainingContract: 0, completionPercent: 0,
      },
    };
  }
  const conditions: any[] = [
    eq(contractingProgressBillsTable.companyId, companyId),
    inArray(contractingProgressBillsTable.projectId, allowedProjectIds),
  ];
  if (filters.projectId) conditions.push(eq(contractingProgressBillsTable.projectId, filters.projectId));
  if (filters.direction === "incoming" || filters.direction === "outgoing") {
    conditions.push(eq(contractingProgressBillsTable.direction, filters.direction));
  }
  const bills = await db.select().from(contractingProgressBillsTable)
    .where(and(...conditions))
    .orderBy(desc(contractingProgressBillsTable.billDate), desc(contractingProgressBillsTable.id));
  if (bills.length === 0) return {
    bills: [],
    totals: {
      grossWorks: 0, previousWorks: 0, currentWorks: 0, cumulativeWorks: 0,
      deductions: 0, retentions: 0, penalties: 0, payments: 0, outstanding: 0,
      contractValue: 0, remainingContract: 0, completionPercent: 0,
    },
  };
  const ids = bills.map((bill) => bill.id);
  const [lines, deductions, penalties, projectRows, reportOwnerContracts] = await Promise.all([
    db.select().from(contractingBillLinesTable).where(eq(contractingBillLinesTable.companyId, companyId)),
    db.select().from(contractingBillDeductionsTable).where(eq(contractingBillDeductionsTable.companyId, companyId)),
    db.select().from(contractingBillPenaltiesTable).where(eq(contractingBillPenaltiesTable.companyId, companyId)),
    db.select({ id: contractingProjectsTable.id, contractValue: contractingProjectsTable.contractValue })
      .from(contractingProjectsTable).where(and(
        eq(contractingProjectsTable.companyId, companyId),
        inArray(contractingProjectsTable.id, allowedProjectIds),
      )),
    db.select({
      projectId: contractingOwnerContractsTable.projectId,
      contractType: contractingOwnerContractsTable.contractType,
      value: contractingOwnerContractsTable.value,
    }).from(contractingOwnerContractsTable).where(and(
      eq(contractingOwnerContractsTable.companyId, companyId),
      inArray(contractingOwnerContractsTable.projectId, allowedProjectIds),
    )),
  ]);
  const settlementMap = await settlementTotals(companyId);
  const selected = new Set(ids);
  const projectContractValues = new Map(projectRows.map((project) => {
    const owner = reportOwnerContracts.filter((contract) => contract.projectId === project.id);
    const main = owner.find((contract) => contract.contractType === "main");
    const changeOrders = owner
      .filter((contract) => contract.contractType === "change_order" || contract.contractType === "addendum")
      .reduce((total, contract) => total + Number(contract.value), 0);
    return [project.id, Number(main?.value ?? project.contractValue ?? 0) + changeOrders] as const;
  }));
  const reportRows = bills.map((bill) => {
    const billLines = lines.filter((line) => line.billId === bill.id && selected.has(line.billId));
    const billDeductions = deductions.filter((row) => row.billId === bill.id);
    const billPenalties = penalties.filter((row) => row.billId === bill.id);
    const retention = Number(bill.retentionAmount);
    const extraDeductions = billDeductions
      .filter((row) => !["retention", "advance", "settlement"].includes(row.kind))
      .reduce((total, row) => total + Number(row.amount), 0);
    const deductionTotal = retention + extraDeductions;
    const settlementPaid = settlementMap.get(bill.id) ?? 0;
    // Existing paidAmount and accounting settlements can describe the same
    // payment. Taking the larger authoritative representation avoids double
    // counting while still showing legacy bills with no settlement row.
    const payments = Math.max(Number(bill.paidAmount), settlementPaid);
    const billDeductionsApplied = extraDeductions
      + billPenalties.reduce((total, row) => total + Number(row.amount), 0);
    const contractValue = projectContractValues.get(bill.projectId) ?? 0;
    const cumulativeWorks = billLines.length > 0
      ? billLines.reduce((total, line) => total + Number(line.cumulativeValue), 0)
      : Number(bill.grossAmount);
    return {
      id: bill.id,
      projectId: bill.projectId,
      billNumber: bill.billNumber,
      billDate: bill.billDate,
      direction: bill.direction,
      status: bill.status,
      grossWorks: Number(bill.grossAmount),
      previousWorks: billLines.reduce((total, line) => total + Number(line.previousValue), 0),
      currentWorks: billLines.length > 0
        ? billLines.reduce((total, line) => total + Number(line.currentValue), 0)
        : Number(bill.grossAmount),
      cumulativeWorks,
      contractValue,
      remainingContract: Math.max(0, contractValue - cumulativeWorks),
      completionPercent: contractValue > 0 ? Math.min(100, cumulativeWorks / contractValue * 100) : 0,
      deductions: deductionTotal,
      retentions: retention,
      penalties: billPenalties.reduce((total, row) => total + Number(row.amount), 0),
      vatAmount: Number(bill.vatAmount),
      netAmount: Number(bill.netAmount),
      payments,
      outstanding: Math.max(0, Number(bill.netAmount) - payments - billDeductionsApplied),
      settlementPaid,
    };
  });
  const latestLinesByWorkItem = new Map<string, { previous: number; cumulative: number; billDate: string; billId: number }>();
  const billDateById = new Map(bills.map((bill) => [bill.id, String(bill.billDate)]));
  for (const line of lines) {
    if (!selected.has(line.billId) || line.workItemId == null) continue;
    const bill = bills.find((candidate) => candidate.id === line.billId);
    const workItemKey = `${bill?.direction ?? "unknown"}:${line.workItemId}`;
    const existing = latestLinesByWorkItem.get(workItemKey);
    const date = billDateById.get(line.billId) ?? "";
    if (!existing || date > existing.billDate || (date === existing.billDate && line.billId > existing.billId)) {
      latestLinesByWorkItem.set(workItemKey, {
        previous: Number(line.previousValue),
        cumulative: Number(line.cumulativeValue),
        billDate: date,
        billId: line.billId,
      });
    }
  }
  const totals = reportRows.reduce((totals, row) => ({
    grossWorks: totals.grossWorks + row.grossWorks,
    // Current work is additive across periods. Previous/cumulative are read
    // from only the latest allocation for each work item, avoiding a report
    // that counts the same cumulative amount once per bill.
    currentWorks: totals.currentWorks + row.currentWorks,
    previousWorks: totals.previousWorks,
    cumulativeWorks: totals.cumulativeWorks,
    deductions: totals.deductions + row.deductions,
    retentions: totals.retentions + row.retentions,
    penalties: totals.penalties + row.penalties,
    payments: totals.payments + row.payments,
    outstanding: totals.outstanding + row.outstanding,
    contractValue: totals.contractValue,
    remainingContract: totals.remainingContract,
    completionPercent: totals.completionPercent,
  }), {
    grossWorks: 0, currentWorks: 0, deductions: 0, retentions: 0,
    penalties: 0, payments: 0, outstanding: 0, previousWorks: 0, cumulativeWorks: 0,
    contractValue: 0, remainingContract: 0, completionPercent: 0,
  });
  totals.previousWorks = Array.from(latestLinesByWorkItem.values())
    .reduce((total, row) => total + row.previous, 0);
  totals.cumulativeWorks = Array.from(latestLinesByWorkItem.values())
    .reduce((total, row) => total + row.cumulative, 0);
  const selectedProjects = new Set(reportRows.map((row) => row.projectId));
  totals.contractValue = Array.from(selectedProjects)
    .reduce((total, projectId) => total + (projectContractValues.get(projectId) ?? 0), 0);
  totals.remainingContract = Math.max(0, totals.contractValue - totals.cumulativeWorks);
  totals.completionPercent = totals.contractValue > 0
    ? Math.min(100, totals.cumulativeWorks / totals.contractValue * 100)
    : 0;
  return {
    bills: reportRows,
    totals,
  };
}
