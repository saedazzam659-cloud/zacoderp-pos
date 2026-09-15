import { db } from "@workspace/db";
import { createHash } from "node:crypto";
import {
  accountsTable,
  accountingMappingsTable,
  bankAccountsTable,
  cashBoxesTable,
  costCentersTable,
  contractingEventsTable,
  contractingOwnerContractsTable,
  contractingProjectsTable,
  contractingProgressBillsTable,
  contractingResourcesTable,
  contractingSubContractsTable,
  contractingBillDeductionsTable,
  contractingBillPenaltiesTable,
  contractingBillWorkflowEventsTable,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  stockBalanceTable,
  unitsTable,
  warehousesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertWritableForDate } from "./periodGuard.js";
import { fullAuditFor } from "./journalAudit.js";
import { nextJeSubSequence } from "./sequences.js";
import { canPostDoc, canUnpostDoc } from "./postingRights.js";
import {
  addStockLedgerEntry,
  refreshItemCost,
} from "./stockHelpers.js";
import { resolveItemUnitConversion } from "./unitConversion.js";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import { ensureContractingBillDetailsTables } from "./contracting-bill-details-service.js";
import { contractingBranchAllowed } from "./contracting-security.js";
import {
  contractingBillAmounts,
  contractingBillRoleLines,
  authoritativeCumulativeBillAmounts,
  materialMovementCost,
  reverseAccountingLines,
  validateSettlementCap,
} from "./contracting-accounting-math.js";

type Executor = any;
type RequestLike = any;

const n = (value: unknown): number => {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
};
const money = (value: unknown): string => n(value).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
function idempotencyFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

function assertIdempotentReplay(existing: any, fingerprint: string): void {
  if (String(existing.idempotency_payload_hash ?? "") !== fingerprint) {
    throw failure("مفتاح العملية مستخدم لبيانات مختلفة؛ استخدم مفتاحاً جديداً", 409);
  }
}

function failure(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function resultRows(result: any): any[] {
  return Array.isArray(result) ? result : result?.rows ?? [];
}

/**
 * Match the sales posting lock contract exactly: deterministic two-int
 * advisory namespace (company, item/warehouse key) followed by a row lock.
 * This local helper is intentionally narrow; it avoids changing shared
 * inventory writers while making the contracting writer safe beside them.
 */
async function lockContractingStockBalance(
  tx: Executor,
  companyId: number,
  itemId: number,
  warehouseId: number,
): Promise<{ id: number; qty: number; avgCost: number } | null> {
  // Keep compatibility with legacy writers that use the shared stock:<...>
  // namespace, then take the exact two-int namespace used by sales.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`stock:${companyId}:${itemId}:${warehouseId}`})
    )
  `);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${companyId}::integer,
      hashtext(${`${itemId}:${warehouseId}`})
    )
  `);
  const result = await tx.execute(sql`
    SELECT id, qty, avg_cost
      FROM stock_balance
     WHERE company_id = ${companyId}
       AND item_id = ${itemId}
       AND warehouse_id = ${warehouseId}
     FOR UPDATE
  `);
  const rows = resultRows(result);
  if (rows.length > 1) {
    throw failure(`يوجد أكثر من رصيد للصنف ${itemId} في المخزن ${warehouseId}؛ صحح تكرار أرصدة المخزون قبل الترحيل`, 409);
  }
  const row = rows[0];
  return row ? { id: Number(row.id), qty: n(row.qty), avgCost: n(row.avg_cost) } : null;
}

function camelBill(row: any): any {
  if (!row) return null;
  return {
    ...row,
    companyId: row.company_id,
    projectId: row.project_id,
    billNumber: row.bill_number,
    billDate: row.bill_date,
    direction: row.direction,
    contractorId: row.contractor_id,
    ownerContractId: row.owner_contract_id,
    subcontractorContractId: row.subcontractor_contract_id,
    costCenterId: row.cost_center_id == null ? null : Number(row.cost_center_id),
    grossAmount: row.gross_amount,
    retentionPercent: row.retention_percent,
    retentionAmount: row.retention_amount,
    previousPaid: row.previous_paid,
    dueAmount: row.due_amount,
    vatPercent: row.vat_percent,
    vatAmount: row.vat_amount,
    netAmount: row.net_amount,
    paidAmount: row.paid_amount,
    journalEntryId: row.journal_entry_id,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
  };
}

async function lockBill(tx: Executor, companyId: number, billId: number): Promise<any | null> {
  const locked = await tx.execute(sql`
    SELECT *
      FROM contracting_progress_bills
     WHERE id = ${billId}
       AND company_id = ${companyId}
     FOR UPDATE
  `);
  return camelBill(resultRows(locked)[0]);
}

async function projectFor(tx: Executor, companyId: number, projectId: number): Promise<any | null> {
  const [project] = await tx.select({
    id: contractingProjectsTable.id,
    branchId: contractingProjectsTable.branchId,
    customerId: contractingProjectsTable.customerId,
  }).from(contractingProjectsTable).where(and(
    eq(contractingProjectsTable.id, projectId),
    eq(contractingProjectsTable.companyId, companyId),
  ));
  return project ?? null;
}

// Bill cost-centre IDs are stored as the text dimension on JE lines (the
// reporting layer resolves either numeric IDs or catalogue codes). Resolve
// only the saved bill snapshot here; approval must never consult the mutable
// project default.
async function billCostCenterTag(
  tx: Executor,
  companyId: number,
  costCenterId: number | null | undefined,
): Promise<string | null> {
  if (costCenterId == null) return null;
  const [center] = await tx.select({ id: costCentersTable.id })
    .from(costCentersTable)
    .where(and(
      eq(costCentersTable.id, costCenterId),
      eq(costCentersTable.companyId, companyId),
    ));
  if (!center) throw failure("مركز تكلفة المستخلص غير موجود في نفس الشركة", 409);
  return String(center.id);
}

export function assertBranchAccess(req: RequestLike, branchId: number | null | undefined): void {
  const user = req?.authUser;
  if (!user || user.role === "admin" || user.role === "superadmin" || user.viewAllBranches) return;
  if (branchId != null && !(user.branchIds ?? []).includes(Number(branchId))) {
    throw failure("ليس لديك صلاحية هذا الفرع", 403);
  }
}

/**
 * Project routes must not treat an unassigned project as a company-wide
 * fallback for a branch-restricted user.  Keep the legacy assertBranchAccess
 * semantics for accounting rows, and use this stricter guard at project
 * boundaries.
 */
export function assertProjectBranchAccess(req: RequestLike, branchId: number | null | undefined): void {
  if (!contractingBranchAllowed(req?.authUser, branchId)) {
    throw failure("ليس لديك صلاحية هذا الفرع", 403);
  }
}

async function mappings(tx: Executor, companyId: number, documentType: string): Promise<Map<string, number>> {
  const rows = await tx.select({
    roleKey: accountingMappingsTable.roleKey,
    accountId: accountingMappingsTable.accountId,
  }).from(accountingMappingsTable).where(and(
    eq(accountingMappingsTable.companyId, companyId),
    eq(accountingMappingsTable.documentType, documentType),
  ));
  return new Map(rows.filter((r: any) => r.accountId != null).map((r: any) => [r.roleKey, Number(r.accountId)]));
}

/**
 * Lock the selected owner/subcontractor contract and derive this
 * certification's period delta from prior certified cumulative bills.  Paid
 * amounts are deliberately not part of this calculation: payment settles a
 * certified delta and must never change the next certification's gross base.
 */
async function certifyBillAmounts(tx: Executor, companyId: number, bill: any): Promise<any> {
  const contractId = bill.direction === "incoming"
    ? Number(bill.subcontractorContractId ?? 0)
    : Number(bill.ownerContractId ?? 0);
  if (!Number.isInteger(contractId) || contractId <= 0) {
    throw failure(
      bill.direction === "incoming"
        ? "يجب تحديد عقد المقاول الباطن قبل اعتماد المستخلص"
        : "يجب تحديد عقد المالك قبل اعتماد المستخلص",
      422,
    );
  }
  const contractTable = bill.direction === "incoming"
    ? "contracting_sub_contracts"
    : "contracting_owner_contracts";
  const contract = await tx.execute(sql`
    SELECT id
      FROM ${sql.raw(contractTable)}
     WHERE id = ${contractId}
       AND company_id = ${companyId}
       AND project_id = ${bill.projectId}
     FOR UPDATE
  `);
  if (!resultRows(contract).length) throw failure("العقد المرتبط بالمستخلص غير موجود في نفس الشركة والمشروع", 422);

  const contractColumn = bill.direction === "incoming" ? "subcontractor_contract_id" : "owner_contract_id";
  const priorResult = await tx.execute(sql`
    SELECT
      COALESCE(MAX(gross_amount), 0) AS prior_gross,
      COALESCE(MAX(retention_amount), 0) AS prior_retention
      FROM contracting_progress_bills
     WHERE company_id = ${companyId}
       AND project_id = ${bill.projectId}
       AND direction = ${bill.direction}
       AND ${sql.raw(contractColumn)} = ${contractId}
       AND id <> ${bill.id}
       AND status IN ('approved', 'paid')
  `);
  const prior = resultRows(priorResult)[0] ?? {};
  const amounts = authoritativeCumulativeBillAmounts({
    grossAmount: bill.grossAmount,
    retentionPercent: bill.retentionPercent ?? 0,
    vatPercent: bill.vatPercent ?? 15,
    priorGrossAmount: prior.prior_gross ?? 0,
    priorRetentionAmount: prior.prior_retention ?? 0,
  });
  await tx.update(contractingProgressBillsTable).set({
    grossAmount: amounts.grossAmount,
    previousPaid: amounts.previousPaid,
    retentionAmount: amounts.retentionAmount,
    dueAmount: amounts.dueAmount,
    vatAmount: amounts.vatAmount,
    netAmount: amounts.netAmount,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProgressBillsTable.id, bill.id),
    eq(contractingProgressBillsTable.companyId, companyId),
  ));
  return { ...bill, ...amounts, id: bill.id };
}

/**
 * Detail deductions are not allowed to silently alter a posted bill.  The
 * base gross/VAT fields remain immutable; only explicitly mapped adjustment
 * accounts may be included in the approval JE. Retention and advance
 * deductions are references to their dedicated accounting flows, so posting
 * them again here would double count.
 */
async function billDetailAdjustments(
  tx: Executor,
  companyId: number,
  bill: any,
  map: Map<string, number>,
) {
  const deductions = await tx.select().from(contractingBillDeductionsTable).where(and(
    eq(contractingBillDeductionsTable.companyId, companyId),
    eq(contractingBillDeductionsTable.billId, bill.id),
  ));
  const penalties = await tx.select().from(contractingBillPenaltiesTable).where(and(
    eq(contractingBillPenaltiesTable.companyId, companyId),
    eq(contractingBillPenaltiesTable.billId, bill.id),
  ));
  const retentionRows = deductions.filter((row: any) => row.kind === "retention");
  const retention = retentionRows
    .reduce((sum: number, row: any) => sum + n(row.amount), 0);
  if (retentionRows.length > 0 && Math.abs(retention - n(bill.retentionAmount)) > 0.005) {
    throw failure("استقطاع المحتجزات في تفاصيل المستخلص يكرر أو لا يطابق محتجزات القيد", 422);
  }
  const advance = deductions
    .filter((row: any) => row.kind === "advance")
    .reduce((sum: number, row: any) => sum + n(row.amount), 0);
  if (advance > n(bill.netAmount) + 0.005) {
    throw failure("استقطاع السلفة يتجاوز صافي المستخلص؛ راجع سقف تطبيق السلفة", 422);
  }
  const unsupportedSettlement = deductions
    .filter((row: any) => row.kind === "settlement")
    .reduce((sum: number, row: any) => sum + n(row.amount), 0);
  if (unsupportedSettlement > 0.005) {
    throw failure("استقطاع التسوية يجب أن يتم من مسار تسوية المستخلص، وليس داخل قيد الاعتماد", 422);
  }
  const mappedDeductions = deductions
    .filter((row: any) => !["retention", "advance", "settlement"].includes(row.kind))
    .filter((row: any) => n(row.amount) > 0)
    .map((row: any) => ({ amount: n(row.amount), role: "deduction", label: `استقطاع ${row.kind}` }));
  const mappedPenalties = penalties
    .filter((row: any) => n(row.amount) > 0)
    .map((row: any) => ({
      amount: n(row.amount),
      role: String(row.accountMappingKey ?? "").trim() || "penalty",
      label: `غرامة ${row.penaltyType}`,
    }));
  const adjustments = [...mappedDeductions, ...mappedPenalties];
  const total = adjustments.reduce((sum, row) => sum + row.amount, 0);
  if (advance + total > n(bill.netAmount) + 0.005) {
    throw failure("إجمالي الاستقطاعات والغرامات يتجاوز صافي المستخلص", 422);
  }
  const deductionAccount = total > 0
    ? map.get("deduction") ?? map.get("deductions")
    : null;
  const penaltyAccounts = mappedPenalties.map((row: { role: string }) => map.get(row.role) ?? map.get("penalty") ?? map.get("penalties") ?? null);
  if (mappedDeductions.some((_row: { amount: number }) => !deductionAccount)) {
    throw failure("حساب الاستقطاعات غير مربوط لهذا النوع من المستخلص؛ لم يتم تجاهل المبلغ", 422);
  }
  if (penaltyAccounts.some((account: number | null) => !account)) {
    throw failure("حساب الغرامات غير مربوط لهذا النوع من المستخلص؛ لم يتم تجاهل المبلغ", 422);
  }
  return { mappedDeductions, mappedPenalties, total, deductionAccount, penaltyAccounts };
}

function appendBillDetailLines(
  lines: Array<{ accountId: number; debit: string; credit: string; description: string; costCenter?: string | null }>,
  details: Awaited<ReturnType<typeof billDetailAdjustments>>,
  direction: "outgoing" | "incoming",
  receivableOrPayable: number,
): Array<{ accountId: number; debit: string; credit: string; description: string; costCenter?: string | null }> {
  if (details.total <= 0) return lines;
  const adjustmentLines = [
    ...details.mappedDeductions.map((row: { amount: number; label: string }) => ({ ...row, accountId: details.deductionAccount! })),
    ...details.mappedPenalties.map((row: { amount: number; label: string }, index: number) => ({ ...row, accountId: details.penaltyAccounts[index]! })),
  ];
  const counterpartLines = adjustmentLines.map((row) => direction === "outgoing"
    ? {
        accountId: row.accountId,
        debit: money(row.amount),
        credit: "0.00",
        description: row.label,
      }
    : {
        accountId: row.accountId,
        debit: "0.00",
        credit: money(row.amount),
        description: row.label,
      });
  const offset = direction === "outgoing"
    ? {
        accountId: receivableOrPayable,
        debit: "0.00",
        credit: money(details.total),
        description: "تخفيض ذمم بسبب الاستقطاعات والغرامات",
      }
    : {
        accountId: receivableOrPayable,
        debit: money(details.total),
        credit: "0.00",
        description: "تخفيض مستحق المقاول بسبب الاستقطاعات والغرامات",
      };
  return [...lines, ...counterpartLines, offset];
}

async function assertAccounts(tx: Executor, companyId: number, ids: number[]): Promise<void> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) throw failure("لا يوجد حساب محاسبي مضبوط لهذه العملية");
  const rows = await tx.select({ id: accountsTable.id }).from(accountsTable).where(and(
    eq(accountsTable.companyId, companyId),
    inArray(accountsTable.id, unique),
  ));
  const found = new Set(rows.map((r: any) => r.id));
  if (unique.some((id) => !found.has(id))) {
    throw failure("أحد الحسابات المحاسبية غير موجود في شجرة هذه الشركة");
  }
}

async function insertJournal(
  tx: Executor,
  companyId: number,
  input: {
    docNumber: string;
    date: string;
    branchId?: number | null;
    description: string;
    entryType: string;
    lines: Array<{
      accountId: number;
      debit: string;
      credit: string;
      description: string;
      costCenter?: string | null;
    }>;
    req?: RequestLike;
  },
): Promise<number> {
  const debit = input.lines.reduce((sum, line) => sum + n(line.debit), 0);
  const credit = input.lines.reduce((sum, line) => sum + n(line.credit), 0);
  if (Math.abs(debit - credit) > 0.01 || debit <= 0) {
    throw failure(`القيد غير متوازن: مدين ${money(debit)} ودائن ${money(credit)}`);
  }
  await assertAccounts(tx, companyId, input.lines.map((line) => line.accountId));
  const writability = await assertWritableForDate(companyId, input.date);
  if (!writability.ok) throw failure(writability.reason, 423);
  const [entry] = await tx.insert(journalEntriesTable).values({
    companyId,
    branchId: input.branchId ?? null,
    docNumber: input.docNumber,
    entryDate: input.date,
    currency: "SAR",
    exchangeRate: "1",
    description: input.description,
    entryType: input.entryType,
    status: "posted",
    periodId: writability.period?.id ?? null,
    ...(input.req ? fullAuditFor(input.req, "posted") : {}),
  }).returning({ id: journalEntriesTable.id });
  await tx.insert(journalEntryLinesTable).values(input.lines.map((line, index) => ({
    entryId: entry.id,
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    description: line.description,
    costCenter: line.costCenter ?? null,
    sortOrder: index,
  })));
  return entry.id;
}

function billLines(bill: any, map: Map<string, number>): {
  accountId: number; debit: string; credit: string; description: string;
}[] {
  const amount = contractingBillAmounts(bill);
  const roleLines = contractingBillRoleLines(bill);
  if (bill.direction === "outgoing") {
    const ar = map.get("receivable");
    const ret = map.get("retention_receivable");
    const revenue = map.get("revenue");
    const vatOutput = map.get("vat_output");
    if (!ar || (amount.retention > 0 && !ret) || (amount.period > 0 && !revenue) || (amount.vat > 0 && !vatOutput)) {
      throw failure("أكمل ربط حسابات مستخلصات المالك (الذمم، المحتجزات، الإيراد، ضريبة المخرجات)");
    }
    return roleLines.map((line) => ({
      accountId: line.role === "receivable" ? ar
        : line.role === "retention_receivable" ? ret!
        : line.role === "revenue" ? revenue!
        : vatOutput!,
      debit: line.debit,
      credit: line.credit,
      description: line.description,
    }));
  }
  const wip = map.get("wip");
  const vatInput = map.get("vat_input");
  const payable = map.get("payable");
  const ret = map.get("retention_payable");
  if (!wip || !payable || (amount.retention > 0 && !ret) || (amount.vat > 0 && !vatInput)) {
    throw failure("أكمل ربط حسابات مستخلصات الباطن (الأعمال تحت التنفيذ، الضريبة، المورد، المحتجزات)");
  }
  return roleLines.map((line) => ({
    accountId: line.role === "wip" ? wip
      : line.role === "vat_input" ? vatInput!
      : line.role === "payable" ? payable
      : ret!,
    debit: line.debit,
    credit: line.credit,
    description: line.description,
  }));
}

async function nextJeNumber(companyId: number, sourceType: string, date: string, userId: number | null): Promise<string> {
  return (await nextJeSubSequence(companyId, sourceType, {
    userId,
    refTable: "journal_entries",
    docDate: date,
  })) ?? `CTG-${companyId}-${Date.now()}`;
}

async function addAudit(tx: Executor, values: {
  companyId: number;
  projectId?: number | null;
  billId?: number | null;
  settlementId?: number | null;
  materialMovementId?: number | null;
  action: string;
  originalJournalEntryId?: number | null;
  reversalJournalEntryId?: number | null;
  amount?: number | null;
  metadata?: Record<string, unknown>;
  userId?: number | null;
}) {
  await tx.execute(sql`
    INSERT INTO contracting_accounting_audit
      (company_id, project_id, bill_id, settlement_id, material_movement_id,
       action, original_journal_entry_id, reversal_journal_entry_id, amount,
       metadata, user_id)
    VALUES (
      ${values.companyId}, ${values.projectId ?? null}, ${values.billId ?? null},
      ${values.settlementId ?? null}, ${values.materialMovementId ?? null},
      ${values.action}, ${values.originalJournalEntryId ?? null},
      ${values.reversalJournalEntryId ?? null}, ${values.amount == null ? null : money(values.amount)},
      ${JSON.stringify(values.metadata ?? {})}::jsonb, ${values.userId ?? null}
    )
  `);
}

export async function approveBill(input: {
  companyId: number;
  billId: number;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  await ensureContractingBillDetailsTables();
  const bill = await db.transaction(async (tx) => {
    const locked = await lockBill(tx, input.companyId, input.billId);
    if (!locked) throw failure("المستخلص غير موجود", 404);
    const project = await projectFor(tx, input.companyId, locked.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertBranchAccess(input.req, project.branchId);
    const postingKey = locked.direction === "incoming" ? "ctgIncomingBill" : "ctgOutgoingBill";
    if (!canPostDoc(input.req.authUser, postingKey)) throw failure("ليس لديك صلاحية ترحيل هذا النوع من المستخلصات", 403);
    if (locked.status === "approved" && locked.journalEntryId) {
      const [existingEntry] = await tx.select({ status: journalEntriesTable.status })
        .from(journalEntriesTable).where(and(
          eq(journalEntriesTable.id, Number(locked.journalEntryId)),
          eq(journalEntriesTable.companyId, input.companyId),
        ));
      if (!existingEntry || existingEntry.status !== "posted") {
        throw failure("المستخلص معتمد لكن القيد المرتبط غير مرحّل؛ لا يمكن إنشاء قيد مكرر", 409);
      }
      return { ...locked, idempotentReplay: true };
    }
    if (locked.status === "approved") {
      throw failure("المستخلص معتمد لكن قيده المحاسبي مفقود؛ لا يمكن إنشاء قيد مكرر", 409);
    }
    if (locked.journalEntryId) {
      const audit = await tx.execute(sql`
        SELECT id FROM contracting_accounting_audit
         WHERE company_id = ${input.companyId}
           AND bill_id = ${input.billId}
           AND action = 'bill_unapproved'
         LIMIT 1
      `);
      if (!resultRows(audit).length) {
        throw failure("للمستخلص قيد سابق غير معكوس؛ استخدم فك الاعتماد الصريح", 409);
      }
    }
    Object.assign(locked, await certifyBillAmounts(tx, input.companyId, locked));
    const map = await mappings(tx, input.companyId,
      locked.direction === "incoming" ? "contracting_incoming_bill" : "contracting_outgoing_bill");
    const detailAdjustments = await billDetailAdjustments(tx, input.companyId, locked, map);
    const billCostCenter = await billCostCenterTag(tx, input.companyId, locked.costCenterId);
    const baseLines = billLines(locked, map).map((line) => ({
      ...line,
      costCenter: billCostCenter,
    }));
    const lines = appendBillDetailLines(
      baseLines,
      detailAdjustments,
      locked.direction,
      map.get(locked.direction === "outgoing" ? "receivable" : "payable")!,
    ).map((line) => ({ ...line, costCenter: billCostCenter }));
    const jeNumber = await nextJeNumber(input.companyId, "contracting_bill_approval", locked.billDate, input.userId);
    const jeId = await insertJournal(tx, input.companyId, {
      docNumber: jeNumber,
      date: locked.billDate,
      branchId: project.branchId,
      description: `اعتماد مستخلص ${locked.billNumber} — مشروع #${locked.projectId}`,
      entryType: locked.direction === "incoming" ? "contracting_incoming_bill" : "contracting_outgoing_bill",
      lines,
      req: input.req,
    });
    const [updated] = await tx.update(contractingProgressBillsTable).set({
      status: "approved",
      journalEntryId: jeId,
      approvedByUserId: input.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(contractingProgressBillsTable.id, input.billId),
      eq(contractingProgressBillsTable.companyId, input.companyId),
    )).returning();
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: locked.projectId,
      billId: input.billId,
      action: "bill_approved",
      originalJournalEntryId: jeId,
      amount: n(locked.netAmount),
      userId: input.userId,
    });
    // The accounting approval is the sole source of truth for the workflow
    // `approved` state.  The detail workflow endpoint delegates here, while
    // direct accounting-panel approvals get the same immutable event.
    await tx.insert(contractingBillWorkflowEventsTable).values({
      companyId: input.companyId,
      projectId: locked.projectId,
      billId: input.billId,
      state: "approved",
      action: "accounting_approve",
      note: "تم الاعتماد مع قيد محاسبي مرحّل",
      userId: input.userId,
    });
    if (locked.direction === "incoming") {
      const allocatedCost = Math.max(0, n(locked.grossAmount) - n(locked.previousPaid));
      if (allocatedCost > 0) {
        await tx.update(contractingProjectsTable).set({
          actualCost: sql`${contractingProjectsTable.actualCost} + ${money(allocatedCost)}::numeric`,
          updatedAt: new Date(),
        }).where(and(
          eq(contractingProjectsTable.id, locked.projectId),
          eq(contractingProjectsTable.companyId, input.companyId),
        ));
      }
    }
    await tx.insert(contractingEventsTable).values({
      companyId: input.companyId,
      projectId: locked.projectId,
      userId: input.userId,
      eventType: "bill_approved",
      title: `اعتماد مستخلص ${locked.billNumber}`,
      description: `تم إنشاء القيد المرحّل رقم ${jeNumber}`,
      meta: { journalEntryId: jeId, atomic: true },
    });
    return { ...updated, idempotentReplay: false };
  });
  return bill;
}

export async function unapproveBill(input: {
  companyId: number;
  billId: number;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  await ensureContractingBillDetailsTables();
  const reversalDate = today();
  const out = await db.transaction(async (tx) => {
    const bill = await lockBill(tx, input.companyId, input.billId);
    if (!bill) throw failure("المستخلص غير موجود", 404);
    const project = await projectFor(tx, input.companyId, bill.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertBranchAccess(input.req, project.branchId);
    const postingKey = bill.direction === "incoming" ? "ctgIncomingBill" : "ctgOutgoingBill";
    if (!canUnpostDoc(input.req.authUser, postingKey)) throw failure("ليس لديك صلاحية فك ترحيل هذا النوع من المستخلصات", 403);
    if (bill.status !== "approved") throw failure("المستخلص ليس معتمداً", 409);
    if (!bill.journalEntryId) throw failure("لا يمكن فك اعتماد مستخلص بلا قيد", 409);
    const linked = await tx.execute(sql`
      SELECT id FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND bill_id = ${input.billId}
         AND status = 'posted'
       LIMIT 1
    `);
    if (resultRows(linked).length) {
      throw failure("لا يمكن فك الاعتماد بعد وجود تسوية مرتبطة بالمستخلص", 409);
    }
    const [original] = await tx.select().from(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, Number(bill.journalEntryId)),
      eq(journalEntriesTable.companyId, input.companyId),
    ));
    if (!original || original.status !== "posted") {
      throw failure("القيد الأصلي غير مرحّل أو غير موجود", 409);
    }
    const ourApproval = await tx.execute(sql`
      SELECT id FROM contracting_accounting_audit
       WHERE company_id = ${input.companyId}
         AND bill_id = ${input.billId}
         AND action = 'bill_approved'
         AND original_journal_entry_id = ${original.id}
       LIMIT 1
    `);
    const originalLines = await tx.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, original.id));
    const reversalNumber = await nextJeNumber(input.companyId, "contracting_bill_reversal", reversalDate, input.userId);
    const reversalId = await insertJournal(tx, input.companyId, {
      docNumber: reversalNumber,
      date: reversalDate,
      branchId: project.branchId,
      description: `عكس اعتماد مستخلص ${bill.billNumber} — القيد ${original.docNumber ?? original.id}`,
      entryType: "contracting_bill_reversal",
      lines: reverseAccountingLines(originalLines).map((reversed, index) => ({
        ...reversed,
        // Keep the original account/cost-center allocation while reversing
        // only the debit/credit side.
        accountId: Number(originalLines[index].accountId),
        costCenter: originalLines[index].costCenter,
      })),
      req: input.req,
    });
    const [updated] = await tx.update(contractingProgressBillsTable).set({
      status: "submitted",
      approvedAt: null,
      approvedByUserId: null,
      // Keep the original JE id as a permanent source trace. The audit row
      // below points to the reversal; a later approval replaces this pointer.
      updatedAt: new Date(),
    }).where(and(
      eq(contractingProgressBillsTable.id, input.billId),
      eq(contractingProgressBillsTable.companyId, input.companyId),
    )).returning();
    await tx.insert(contractingBillWorkflowEventsTable).values({
      companyId: input.companyId,
      projectId: bill.projectId,
      billId: input.billId,
      state: "submitted",
      action: "accounting_unapprove",
      note: "تم فك الاعتماد وإنشاء القيد العكسي",
      userId: input.userId,
    });
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: bill.projectId,
      billId: input.billId,
      action: "bill_unapproved",
      originalJournalEntryId: original.id,
      reversalJournalEntryId: reversalId,
      amount: n(bill.netAmount),
      metadata: { reversalDate },
      userId: input.userId,
    });
    if (bill.direction === "incoming" && resultRows(ourApproval).length) {
      const allocatedCost = Math.max(0, n(bill.grossAmount) - n(bill.previousPaid));
      if (allocatedCost > 0) {
        await tx.update(contractingProjectsTable).set({
          actualCost: sql`GREATEST(0, ${contractingProjectsTable.actualCost} - ${money(allocatedCost)}::numeric)`,
          updatedAt: new Date(),
        }).where(and(
          eq(contractingProjectsTable.id, bill.projectId),
          eq(contractingProjectsTable.companyId, input.companyId),
        ));
      }
    }
    await tx.insert(contractingEventsTable).values({
      companyId: input.companyId,
      projectId: bill.projectId,
      userId: input.userId,
      eventType: "bill_unapproved",
      title: `فك اعتماد مستخلص ${bill.billNumber}`,
      description: `تم إنشاء قيد عكسي مرحّل رقم ${reversalNumber}`,
      severity: "warn",
      meta: { originalJournalEntryId: original.id, reversalJournalEntryId: reversalId },
    });
    return { ...updated, reversalJournalEntryId: reversalId, originalJournalEntryId: original.id };
  });
  return out;
}

export async function billMutationGuard(companyId: number, billId: number, action: "edit" | "delete") {
  await ensureContractingAccountingTables();
  const [bill] = await db.select({
    id: contractingProgressBillsTable.id,
    status: contractingProgressBillsTable.status,
    journalEntryId: contractingProgressBillsTable.journalEntryId,
  }).from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  ));
  if (!bill) throw failure("المستخلص غير موجود", 404);
  if (["approved", "posted", "partially_paid", "paid"].includes(String(bill.status))) {
    throw failure(`لا يمكن ${action === "delete" ? "حذف" : "تعديل"} مستخلص معتمد وله أثر في دفتر الأستاذ؛ استخدم فك الاعتماد`, 409);
  }
  if (action === "delete" && bill.journalEntryId) {
    throw failure("لا يمكن حذف مستخلص له أثر محاسبي محفوظ في سجل المراجعة", 409);
  }
  return bill;
}

function settlementKindDetails(kind: string) {
  const details: Record<string, { direction: "outgoing" | "incoming"; mapping: string; debitRole: string; creditRole: string }> = {
    advance_receipt: { direction: "outgoing", mapping: "contracting_advance_receipt", debitRole: "treasury", creditRole: "advance_liability" },
    advance_payment: { direction: "incoming", mapping: "contracting_advance_payment", debitRole: "advance_asset", creditRole: "treasury" },
    retention_receipt: { direction: "outgoing", mapping: "contracting_retention_receipt", debitRole: "treasury", creditRole: "retention_receivable" },
    retention_payment: { direction: "incoming", mapping: "contracting_retention_payment", debitRole: "retention_payable", creditRole: "treasury" },
    bill_receipt: { direction: "outgoing", mapping: "contracting_outgoing_bill", debitRole: "treasury", creditRole: "receivable" },
    bill_payment: { direction: "incoming", mapping: "contracting_incoming_bill", debitRole: "payable", creditRole: "treasury" },
  };
  return details[kind];
}

async function treasuryAccount(tx: Executor, companyId: number, paymentType: string, cashBoxId: number | null, bankAccountId: number | null) {
  if (paymentType === "cash") {
    if (!cashBoxId) throw failure("الخزنة مطلوبة");
    const [cash] = await tx.select({
      id: cashBoxesTable.id, branchId: cashBoxesTable.branchId,
      accountId: cashBoxesTable.accountId, nameAr: cashBoxesTable.nameAr,
    }).from(cashBoxesTable).where(and(
      eq(cashBoxesTable.id, cashBoxId),
      eq(cashBoxesTable.companyId, companyId),
      eq(cashBoxesTable.isActive, true),
    ));
    if (!cash || !cash.accountId) throw failure("الخزنة غير موجودة أو غير مرتبطة بحساب محاسبي");
    return {
      accountId: Number(cash.accountId), branchId: cash.branchId,
      branchIds: cash.branchId == null ? [] : [cash.branchId],
      label: `الخزنة ${cash.nameAr}`,
    };
  }
  if (paymentType === "bank") {
    if (!bankAccountId) throw failure("الحساب البنكي مطلوب");
    const [bank] = await tx.select({
      id: bankAccountsTable.id, branchId: bankAccountsTable.branchId,
      branchIds: bankAccountsTable.branchIds,
      accountId: bankAccountsTable.accountId, nameAr: bankAccountsTable.nameAr,
    }).from(bankAccountsTable).where(and(
      eq(bankAccountsTable.id, bankAccountId),
      eq(bankAccountsTable.companyId, companyId),
      eq(bankAccountsTable.isActive, true),
    ));
    if (!bank || !bank.accountId) throw failure("الحساب البنكي غير موجود أو غير مرتبط بحساب محاسبي");
    const branchIds = [...new Set([
      ...(bank.branchIds ?? []),
      ...(bank.branchId == null ? [] : [bank.branchId]),
    ])].map(Number);
    return { accountId: Number(bank.accountId), branchId: bank.branchId, branchIds, label: `البنك ${bank.nameAr}` };
  }
  throw failure("نوع السداد يجب أن يكون نقداً أو بنكياً");
}

export async function createSettlement(input: {
  companyId: number;
  projectId: number;
  billId?: number | null;
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  kind: string;
  amount: number;
  settlementDate: string;
  paymentType: "cash" | "bank";
  cashBoxId?: number | null;
  bankAccountId?: number | null;
  idempotencyKey: string;
  notes?: string | null;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  const details = settlementKindDetails(input.kind);
  if (!details) throw failure("نوع التسوية غير صالح");
  if (!(input.amount > 0)) throw failure("المبلغ يجب أن يكون أكبر من صفر");
  const payloadHash = idempotencyFingerprint({
    projectId: input.projectId,
    billId: input.billId ?? null,
    ownerContractId: input.ownerContractId ?? null,
    subcontractorContractId: input.subcontractorContractId ?? null,
    kind: input.kind,
    amount: money(input.amount),
    settlementDate: input.settlementDate || today(),
    paymentType: input.paymentType,
    cashBoxId: input.cashBoxId ?? null,
    bankAccountId: input.bankAccountId ?? null,
    notes: input.notes ?? null,
  });
  const existing = await db.execute(sql`
    SELECT * FROM contracting_accounting_settlements
     WHERE company_id = ${input.companyId}
       AND idempotency_key = ${input.idempotencyKey}
     LIMIT 1
  `);
  if (resultRows(existing)[0]) {
    const row = resultRows(existing)[0];
    assertIdempotentReplay(row, payloadHash);
    return { ...row, idempotentReplay: true };
  }
  const settlementDate = input.settlementDate || today();
  const out = await db.transaction(async (tx) => {
    const project = await projectFor(tx, input.companyId, input.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertBranchAccess(input.req, project.branchId);
    let bill: any = null;
    const requiresBill = input.kind.startsWith("retention_") || input.kind.startsWith("bill_");
    if (input.billId != null) {
      bill = await lockBill(tx, input.companyId, input.billId);
      if (!bill || bill.projectId !== input.projectId) throw failure("المستخلص غير صالح لهذا المشروع");
      if (bill.direction !== details.direction) throw failure("اتجاه التسوية لا يطابق اتجاه المستخلص");
      if (bill.status !== "approved" || !bill.journalEntryId) throw failure("يجب اعتماد المستخلص قبل تسوية المستخلص");
    }
    if (requiresBill && !bill) {
      throw failure("هذه التسوية تتطلب مستخلصاً معتمداً");
    }
    const ownerContractId = bill
      ? Number(bill.ownerContractId ?? 0) || null
      : (Number(input.ownerContractId ?? 0) || null);
    const subcontractorContractId = bill
      ? Number(bill.subcontractorContractId ?? 0) || null
      : (Number(input.subcontractorContractId ?? 0) || null);
    if (input.kind === "advance_receipt" && !ownerContractId) {
      throw failure("قبض سلفة المالك يتطلب عقد مالك محدداً");
    }
    if (input.kind === "advance_payment" && !subcontractorContractId) {
      throw failure("صرف سلفة المقاول الباطن يتطلب عقداً محدداً");
    }
    if (bill && (
      (input.ownerContractId != null && Number(input.ownerContractId) !== ownerContractId) ||
      (input.subcontractorContractId != null && Number(input.subcontractorContractId) !== subcontractorContractId)
    )) {
      throw failure("العقد المحدد لا يطابق عقد المستخلص");
    }
    const contractId = details.direction === "outgoing" ? ownerContractId : subcontractorContractId;
    if (!contractId) throw failure("العقد المرتبط بالتسوية مطلوب");
    const contractTable = details.direction === "outgoing"
      ? "contracting_owner_contracts"
      : "contracting_sub_contracts";
    const contract = await tx.execute(sql`
      SELECT id FROM ${sql.raw(contractTable)}
       WHERE company_id = ${input.companyId}
         AND project_id = ${input.projectId}
         AND id = ${contractId}
       FOR UPDATE
    `);
    if (!resultRows(contract).length) throw failure("العقد المرتبط بالتسوية غير موجود في نفس الشركة والمشروع");
    if (input.kind.startsWith("retention_")) {
      const prior = await tx.execute(sql`
        SELECT COALESCE(SUM(amount),0) AS total
          FROM contracting_accounting_settlements
         WHERE company_id = ${input.companyId}
           AND bill_id = ${input.billId}
           AND kind = ${input.kind}
           AND status = 'posted'
      `);
      const already = n(resultRows(prior)[0]?.total);
      const cap = validateSettlementCap({
        kind: input.kind as "retention_receipt" | "retention_payment",
        requested: input.amount,
        retentionAmount: bill.retentionAmount,
        alreadyReleased: already,
      });
      if (!cap.ok) {
        throw failure(cap.reason);
      }
    }
    if (input.kind.startsWith("bill_")) {
      const cap = validateSettlementCap({
        kind: input.kind as "bill_receipt" | "bill_payment",
        requested: input.amount,
        billNetAmount: bill.netAmount,
        billPaidAmount: bill.paidAmount,
      });
      if (!cap.ok) {
        throw failure(cap.reason);
      }
    }
    const treasury = await treasuryAccount(tx, input.companyId, input.paymentType,
      input.cashBoxId ?? null, input.bankAccountId ?? null);
    for (const branchId of treasury.branchIds ?? []) assertBranchAccess(input.req, branchId);
    if ((treasury.branchIds ?? []).length > 0 &&
        project.branchId != null && !(treasury.branchIds as number[]).includes(Number(project.branchId))) {
      throw failure("الخزنة أو البنك لا يتبع فرع المشروع");
    }
    const map = await mappings(tx, input.companyId, details.mapping);
    const counterpart = map.get(details.creditRole === "treasury" ? details.debitRole : details.creditRole);
    if (!counterpart) throw failure("حساب التسوية غير مربوط؛ راجع ربط القيود المحاسبية");
    const jeNumber = await nextJeNumber(input.companyId, "contracting_settlement", settlementDate, input.userId);
    const lines = details.debitRole === "treasury"
      ? [
          { accountId: treasury.accountId, debit: money(input.amount), credit: "0.00", description: treasury.label, costCenter: `contracting-project:${input.projectId}` },
          { accountId: counterpart, debit: "0.00", credit: money(input.amount), description: `تسوية ${input.kind}`, costCenter: `contracting-project:${input.projectId}` },
        ]
      : [
          { accountId: counterpart, debit: money(input.amount), credit: "0.00", description: `تسوية ${input.kind}`, costCenter: `contracting-project:${input.projectId}` },
          { accountId: treasury.accountId, debit: "0.00", credit: money(input.amount), description: treasury.label, costCenter: `contracting-project:${input.projectId}` },
        ];
    const jeId = await insertJournal(tx, input.companyId, {
      docNumber: jeNumber,
      date: settlementDate,
      branchId: project.branchId ?? treasury.branchId,
      description: `تسوية مقاولات ${input.kind} — مشروع #${input.projectId}`,
      entryType: "contracting_settlement",
      lines,
      req: input.req,
    });
    const inserted = await tx.execute(sql`
      INSERT INTO contracting_accounting_settlements
        (company_id, project_id, bill_id, owner_contract_id, subcontractor_contract_id,
         kind, direction, amount,
         settlement_date, payment_type, cash_box_id, bank_account_id,
         journal_entry_id, idempotency_key, idempotency_payload_hash, notes, created_by)
      VALUES (
        ${input.companyId}, ${input.projectId}, ${input.billId ?? null},
        ${ownerContractId}, ${subcontractorContractId},
        ${input.kind}, ${details.direction}, ${money(input.amount)},
        ${settlementDate}, ${input.paymentType}, ${input.cashBoxId ?? null},
        ${input.bankAccountId ?? null}, ${jeId}, ${input.idempotencyKey}, ${payloadHash},
        ${input.notes ?? null}, ${input.userId}
      )
      RETURNING *
    `);
    const row = resultRows(inserted)[0];
    if (input.kind.startsWith("bill_") && input.billId != null) {
      await tx.execute(sql`
        UPDATE contracting_progress_bills
           SET paid_amount = paid_amount + ${money(input.amount)},
               updated_at = NOW()
         WHERE company_id = ${input.companyId}
           AND id = ${input.billId}
      `);
    }
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      billId: input.billId ?? null,
      settlementId: Number(row.id),
      action: input.kind,
      originalJournalEntryId: jeId,
      amount: input.amount,
      userId: input.userId,
    });
    return { ...row, idempotentReplay: false };
  });
  return out;
}

export async function applyAdvance(input: {
  companyId: number;
  settlementId: number;
  billId: number;
  amount: number;
  idempotencyKey: string;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  if (!(input.amount > 0)) throw failure("مبلغ التطبيق يجب أن يكون أكبر من صفر");
  const payloadHash = idempotencyFingerprint({
    settlementId: input.settlementId,
    billId: input.billId,
    amount: money(input.amount),
  });
  const existing = await db.execute(sql`
    SELECT * FROM contracting_accounting_settlements
     WHERE company_id = ${input.companyId}
       AND idempotency_key = ${input.idempotencyKey}
     LIMIT 1
  `);
  if (resultRows(existing)[0]) {
    const row = resultRows(existing)[0];
    assertIdempotentReplay(row, payloadHash);
    return { ...row, idempotentReplay: true };
  }
  const out = await db.transaction(async (tx) => {
    const sourceResult = await tx.execute(sql`
      SELECT * FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND id = ${input.settlementId}
       FOR UPDATE
    `);
    const source = resultRows(sourceResult)[0];
    if (!source || !["advance_receipt", "advance_payment"].includes(String(source.kind))) {
      throw failure("السلفة غير موجودة أو غير قابلة للتطبيق", 404);
    }
    const bill = await lockBill(tx, input.companyId, input.billId);
    if (!bill || bill.status !== "approved" || !bill.journalEntryId) {
      throw failure("يجب تطبيق السلفة على مستخلص معتمد وله قيد");
    }
    if (Number(source.project_id) !== Number(bill.projectId)) {
      throw failure("السلفة والمستخلص لا يتبعان المشروع نفسه");
    }
    assertBranchAccess(input.req, (await projectFor(tx, input.companyId, bill.projectId))?.branchId);
    const sourceDirection = String(source.direction);
    if (sourceDirection !== bill.direction) throw failure("اتجاه السلفة لا يطابق المستخلص");
    const billContractId = bill.direction === "outgoing"
      ? Number(bill.ownerContractId ?? 0)
      : Number(bill.subcontractorContractId ?? 0);
    const sourceContractId = bill.direction === "outgoing"
      ? Number(source.owner_contract_id ?? 0)
      : Number(source.subcontractor_contract_id ?? 0);
    if (!billContractId || !sourceContractId || billContractId !== sourceContractId) {
      throw failure("السلفة والمستخلص لا يتبعان العقد نفسه؛ لا يمكن تطبيق السلفة");
    }
    const cap = validateSettlementCap({
      kind: "advance_application",
      requested: input.amount,
      availableAdvance: n(source.amount) - n(source.applied_amount),
    });
    if (!cap.ok) throw failure(cap.reason);
    const appliedToBill = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS total
        FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND bill_id = ${input.billId}
         AND kind = 'advance_application'
         AND status = 'posted'
    `);
    const billCap = validateSettlementCap({
      kind: "bill_payment",
      requested: input.amount,
      billNetAmount: bill.netAmount,
      billPaidAmount: n(bill.paidAmount) + n(resultRows(appliedToBill)[0]?.total),
    });
    if (!billCap.ok) throw failure("تطبيق السلفة يتجاوز رصيد المستخلص بعد التسويات والسلف المدفوعة");
    const map = await mappings(tx, input.companyId, "contracting_advance_application");
    const outgoing = bill.direction === "outgoing";
    const debit = map.get(outgoing ? "advance_liability" : "payable");
    const credit = map.get(outgoing ? "receivable" : "advance_asset");
    if (!debit || !credit) throw failure("أكمل ربط حسابات تطبيق السلف قبل الترحيل");
    const applicationDate = today();
    const jeNumber = await nextJeNumber(input.companyId, "contracting_advance_application", applicationDate, input.userId);
    const project = await projectFor(tx, input.companyId, bill.projectId);
    const jeId = await insertJournal(tx, input.companyId, {
      docNumber: jeNumber,
      date: applicationDate,
      branchId: project?.branchId,
      description: `تطبيق سلفة على مستخلص ${bill.billNumber}`,
      entryType: "contracting_advance_application",
      lines: [
        { accountId: debit, debit: money(input.amount), credit: "0.00", description: "تخفيض السلفة", costCenter: `contracting-project:${bill.projectId}` },
        { accountId: credit, debit: "0.00", credit: money(input.amount), description: "تخفيض ذمم المستخلص", costCenter: `contracting-project:${bill.projectId}` },
      ],
      req: input.req,
    });
    const inserted = await tx.execute(sql`
      INSERT INTO contracting_accounting_settlements
        (company_id, project_id, bill_id, owner_contract_id, subcontractor_contract_id,
         kind, direction, amount, applied_amount,
         settlement_date, journal_entry_id, source_settlement_id,
         idempotency_key, idempotency_payload_hash, notes, created_by)
      VALUES (
        ${input.companyId}, ${bill.projectId}, ${input.billId},
        ${bill.direction === "outgoing" ? billContractId : null},
        ${bill.direction === "incoming" ? billContractId : null},
        'advance_application', ${bill.direction}, ${money(input.amount)},
        ${money(input.amount)}, ${applicationDate}, ${jeId},
        ${input.settlementId}, ${input.idempotencyKey}, ${payloadHash},
        'تطبيق سلفة على المستخلص', ${input.userId}
      )
      RETURNING *
    `);
    await tx.execute(sql`
      UPDATE contracting_accounting_settlements
         SET applied_amount = applied_amount + ${money(input.amount)},
             updated_at = NOW()
       WHERE company_id = ${input.companyId}
         AND id = ${input.settlementId}
    `);
    const row = resultRows(inserted)[0];
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: bill.projectId,
      billId: input.billId,
      settlementId: Number(row.id),
      action: "advance_application",
      originalJournalEntryId: jeId,
      amount: input.amount,
      metadata: { sourceSettlementId: input.settlementId },
      userId: input.userId,
    });
    return { ...row, idempotentReplay: false };
  });
  return out;
}

export async function listSettlements(companyId: number, projectId: number) {
  await ensureContractingAccountingTables();
  const result = await db.execute(sql`
    SELECT *
      FROM contracting_accounting_settlements
     WHERE company_id = ${companyId}
       AND project_id = ${projectId}
     ORDER BY settlement_date DESC, id DESC
  `);
  return resultRows(result);
}

export async function listAccountingAudit(companyId: number, projectId: number) {
  await ensureContractingAccountingTables();
  const result = await db.execute(sql`
    SELECT *
      FROM contracting_accounting_audit
     WHERE company_id = ${companyId}
       AND project_id = ${projectId}
     ORDER BY created_at DESC, id DESC
     LIMIT 500
  `);
  return resultRows(result);
}

export async function listMaterialMovements(companyId: number, projectId: number) {
  await ensureContractingAccountingTables();
  const result = await db.execute(sql`
    SELECT *
      FROM contracting_material_movements
     WHERE company_id = ${companyId}
       AND project_id = ${projectId}
     ORDER BY movement_date DESC, id DESC
  `);
  return resultRows(result);
}

export async function issueOrReturnMaterial(input: {
  companyId: number;
  projectId: number;
  resourceId?: number | null;
  itemId: number;
  unitId: number;
  warehouseId: number;
  qty: number;
  direction: "issue" | "return";
  movementDate: string;
  sourceMovementId?: number | null;
  idempotencyKey: string;
  notes?: string | null;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  if (!(input.qty > 0)) throw failure("الكمية يجب أن تكون أكبر من صفر");
  if (!input.idempotencyKey?.trim()) throw failure("مفتاح العملية مطلوب لمنع الترحيل المكرر");
  const payloadHash = idempotencyFingerprint({
    projectId: input.projectId,
    resourceId: input.resourceId ?? null,
    itemId: input.itemId,
    unitId: input.unitId,
    warehouseId: input.warehouseId,
    qty: input.qty,
    direction: input.direction,
    movementDate: input.movementDate,
    sourceMovementId: input.sourceMovementId ?? null,
    notes: input.notes ?? null,
  });
  const existing = await db.execute(sql`
    SELECT * FROM contracting_material_movements
     WHERE company_id = ${input.companyId}
       AND idempotency_key = ${input.idempotencyKey}
     LIMIT 1
  `);
  if (resultRows(existing)[0]) {
    const row = resultRows(existing)[0];
    assertIdempotentReplay(row, payloadHash);
    return { ...row, idempotentReplay: true };
  }
  const out = await db.transaction(async (tx) => {
    const project = await projectFor(tx, input.companyId, input.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertBranchAccess(input.req, project.branchId);
    const [warehouse] = await tx.select({
      id: warehousesTable.id,
      branchId: warehousesTable.branchId,
      allowNegative: warehousesTable.allowNegative,
      isActive: warehousesTable.isActive,
    }).from(warehousesTable).where(and(
      eq(warehousesTable.id, input.warehouseId),
      eq(warehousesTable.companyId, input.companyId),
    ));
    if (!warehouse || !warehouse.isActive) throw failure("المخزن غير موجود أو غير نشط");
    assertBranchAccess(input.req, warehouse.branchId);
    if (project.branchId != null && warehouse.branchId != null && project.branchId !== warehouse.branchId) {
      throw failure("المخزن لا يتبع فرع المشروع");
    }
    const [item] = await tx.select({
      id: itemsTable.id,
      itemType: itemsTable.itemType,
      status: itemsTable.status,
      batchTrackingMode: itemsTable.batchTrackingMode,
      costMethod: itemsTable.costMethod,
    }).from(itemsTable).where(and(
      eq(itemsTable.id, input.itemId),
      eq(itemsTable.companyId, input.companyId),
    ));
    if (!item || item.itemType !== "stock" || item.status !== "active") {
      throw failure("الصنف يجب أن يكون صنف مخزون نشطاً من نفس الشركة");
    }
    if (item.batchTrackingMode !== "none" || item.costMethod !== "weighted_avg") {
      throw failure("حركة مواد المقاولات لا تدعم حالياً أصناف FIFO/FEFO أو غير المتوسط المرجح؛ استخدم مسار تشغيل التشغيلة المدعوم قبل الترحيل", 422);
    }
    const [unit] = await tx.select({ id: unitsTable.id }).from(unitsTable).where(and(
      eq(unitsTable.id, input.unitId),
      eq(unitsTable.companyId, input.companyId),
    ));
    if (!unit) throw failure("وحدة الصنف غير صالحة");
    const conversion = await resolveItemUnitConversion({
      companyId: input.companyId,
      itemId: input.itemId,
      unitId: input.unitId,
      executor: tx,
    });
    const qtyBase = n(input.qty) * n(conversion.factor);
    if (!(qtyBase > 0)) throw failure("تحويل الوحدة أعطى كمية غير صالحة");
    if (input.resourceId != null) {
      const [resource] = await tx.select({
        id: contractingResourcesTable.id,
        projectId: contractingResourcesTable.projectId,
        type: contractingResourcesTable.type,
        itemId: contractingResourcesTable.itemId,
        unitId: contractingResourcesTable.unitId,
        warehouseId: contractingResourcesTable.warehouseId,
      }).from(contractingResourcesTable).where(and(
        eq(contractingResourcesTable.id, input.resourceId),
        eq(contractingResourcesTable.companyId, input.companyId),
      ));
      if (!resource || resource.type !== "material" || Number(resource.projectId) !== input.projectId ||
          Number(resource.itemId) !== input.itemId || Number(resource.unitId) !== input.unitId ||
          Number(resource.warehouseId) !== input.warehouseId) {
        throw failure("مورد المواد لا يطابق الصنف والوحدة والمخزن والمشروع");
      }
    }
    let sourceQtyBase: number | undefined;
    let alreadyReturnedBase = 0;
    if (input.direction === "return") {
      if (!input.sourceMovementId) throw failure("عملية الإرجاع تتطلب مرجع حركة الصرف الأصلية");
      const sourceResult = await tx.execute(sql`
        SELECT * FROM contracting_material_movements
         WHERE company_id = ${input.companyId}
           AND id = ${input.sourceMovementId}
           AND project_id = ${input.projectId}
           AND direction = 'issue'
         AND status = 'posted'
         FOR UPDATE
      `);
      const source = resultRows(sourceResult)[0];
      if (!source || Number(source.item_id) !== input.itemId ||
          Number(source.warehouse_id) !== input.warehouseId) {
        throw failure("حركة الصرف الأصلية غير صالحة لهذا الإرجاع");
      }
      sourceQtyBase = n(source.qty_base);
      const returnedResult = await tx.execute(sql`
        SELECT COALESCE(SUM(qty_base),0) AS total
          FROM contracting_material_movements
         WHERE company_id = ${input.companyId}
           AND source_movement_id = ${input.sourceMovementId}
           AND direction = 'return'
           AND status = 'posted'
      `);
      alreadyReturnedBase = n(resultRows(returnedResult)[0]?.total);
    }
    const balance = await lockContractingStockBalance(tx, input.companyId, input.itemId, input.warehouseId);
    const available = n(balance?.qty);
    if (input.direction === "issue" && available + 0.000001 < qtyBase && !warehouse.allowNegative) {
      throw failure(`الرصيد الفعلي لا يكفي: المتاح ${available.toFixed(4)}، المطلوب ${qtyBase.toFixed(4)}`);
    }
    const unitCost = input.direction === "return"
      ? n(resultRows(await tx.execute(sql`
          SELECT unit_cost FROM contracting_material_movements
           WHERE company_id = ${input.companyId} AND id = ${input.sourceMovementId}
        `))[0]?.unit_cost)
      : n(balance?.avgCost);
    const movementCost = materialMovementCost({
      direction: input.direction,
      qtyBase,
      unitCost,
      sourceQtyBase,
      alreadyReturnedBase,
    });
    if (!movementCost.ok) throw failure(movementCost.reason);
    const totalCost = movementCost.totalCost;
    const delta = input.direction === "issue" ? -qtyBase : qtyBase;
    let newBalance: number;
    if (!balance) {
      await tx.insert(stockBalanceTable).values({
        companyId: input.companyId,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        qty: String(delta),
        avgCost: String(unitCost),
      });
      newBalance = delta;
    } else {
      newBalance = balance.qty + delta;
      const newAverage = delta > 0 && newBalance > 0
        ? ((balance.qty * balance.avgCost) + (delta * unitCost)) / newBalance
        : balance.avgCost;
      await tx.update(stockBalanceTable).set({
        qty: String(newBalance),
        avgCost: String(newAverage),
        updatedAt: new Date(),
      }).where(eq(stockBalanceTable.id, balance.id));
    }
    const insertedMovement = await tx.execute(sql`
      INSERT INTO contracting_material_movements
        (company_id, project_id, resource_id, item_id, unit_id, warehouse_id,
         direction, movement_date, qty, qty_base, unit_cost, total_cost,
         source_movement_id, idempotency_key, idempotency_payload_hash, notes, created_by)
      VALUES (
        ${input.companyId}, ${input.projectId}, ${input.resourceId ?? null},
        ${input.itemId}, ${input.unitId}, ${input.warehouseId},
        ${input.direction}, ${input.movementDate}, ${n(input.qty).toFixed(18)},
        ${qtyBase.toFixed(18)}, ${unitCost.toFixed(6)}, ${money(totalCost)},
        ${input.sourceMovementId ?? null}, ${input.idempotencyKey}, ${payloadHash},
        ${input.notes ?? null}, ${input.userId}
      )
      RETURNING *
    `);
    const movement = resultRows(insertedMovement)[0];
    await addStockLedgerEntry({
      companyId: input.companyId,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      txDate: input.movementDate,
      txType: input.direction === "issue" ? "goods_delivery" : "goods_receipt",
      qty: input.direction === "issue" ? (-qtyBase).toFixed(4) : qtyBase.toFixed(4),
      costPrice: unitCost.toFixed(4),
      totalCost: input.direction === "issue" ? (-totalCost).toFixed(4) : totalCost.toFixed(4),
      balanceQty: Number(newBalance).toFixed(4),
      refId: Number(movement.id),
      refType: `contracting_material_${input.direction}`,
      notes: input.notes ?? undefined,
    }, tx);
    await refreshItemCost(input.companyId, input.itemId, tx);
    const map = await mappings(tx, input.companyId, "contracting_material_movement");
    const inventory = map.get("inventory");
    const wip = map.get("wip");
    if (!inventory || !wip) throw failure("أكمل ربط حساب المخزون وأعمال تحت التنفيذ لحركة مواد المقاولات");
    const jeNumber = await nextJeNumber(input.companyId, "contracting_material", input.movementDate, input.userId);
    const jeId = await insertJournal(tx, input.companyId, {
      docNumber: jeNumber,
      date: input.movementDate,
      branchId: project.branchId,
      description: `${input.direction === "issue" ? "صرف" : "إرجاع"} مواد للمشروع #${input.projectId}`,
      entryType: "contracting_material_movement",
      lines: input.direction === "issue"
        ? [
            { accountId: wip, debit: money(totalCost), credit: "0.00", description: "تكلفة مواد فعلية للمشروع", costCenter: `contracting-project:${input.projectId}` },
            { accountId: inventory, debit: "0.00", credit: money(totalCost), description: "إخراج من المخزون", costCenter: `contracting-project:${input.projectId}` },
          ]
        : [
            { accountId: inventory, debit: money(totalCost), credit: "0.00", description: "إرجاع إلى المخزون", costCenter: `contracting-project:${input.projectId}` },
            { accountId: wip, debit: "0.00", credit: money(totalCost), description: "تخفيض تكلفة مواد المشروع", costCenter: `contracting-project:${input.projectId}` },
          ],
      req: input.req,
    });
    await tx.execute(sql`
      UPDATE contracting_material_movements
         SET journal_entry_id = ${jeId}, updated_at = NOW()
       WHERE company_id = ${input.companyId} AND id = ${Number(movement.id)}
    `);
    await tx.update(contractingProjectsTable).set({
      actualCost: sql`GREATEST(0, ${contractingProjectsTable.actualCost} ${input.direction === "issue" ? sql`+` : sql`-`} ${money(totalCost)}::numeric)`,
      updatedAt: new Date(),
    }).where(and(
      eq(contractingProjectsTable.id, input.projectId),
      eq(contractingProjectsTable.companyId, input.companyId),
    ));
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: input.projectId,
      materialMovementId: Number(movement.id),
      action: `material_${input.direction}`,
      originalJournalEntryId: jeId,
      amount: totalCost,
      metadata: { qtyBase, unitCost, balanceQty: newBalance },
      userId: input.userId,
    });
    return { ...movement, journal_entry_id: jeId, balance_qty: newBalance, idempotentReplay: false };
  });
  return out;
}

export async function inventoryOptions(companyId: number, projectId: number) {
  const [project] = await db.select({ branchId: contractingProjectsTable.branchId })
    .from(contractingProjectsTable).where(and(
      eq(contractingProjectsTable.id, projectId),
      eq(contractingProjectsTable.companyId, companyId),
    ));
  if (!project) throw failure("المشروع غير موجود", 404);
  const warehouses = await db.select({
    id: warehousesTable.id, code: warehousesTable.code, nameAr: warehousesTable.nameAr,
    branchId: warehousesTable.branchId,
  }).from(warehousesTable).where(and(
    eq(warehousesTable.companyId, companyId),
    eq(warehousesTable.isActive, true),
    project.branchId == null
      ? sql`false`
      : eq(warehousesTable.branchId, project.branchId),
  ));
  const items = await db.select({
    id: itemsTable.id, code: itemsTable.code, nameAr: itemsTable.nameAr, unitId: itemsTable.unitId,
  }).from(itemsTable).where(and(
    eq(itemsTable.companyId, companyId),
    eq(itemsTable.itemType, "stock"),
    eq(itemsTable.status, "active"),
  ));
  const units = await db.select({
    id: unitsTable.id, code: unitsTable.code, nameAr: unitsTable.nameAr,
  }).from(unitsTable).where(eq(unitsTable.companyId, companyId));
  const warehouseIds = warehouses.map((warehouse) => warehouse.id);
  const balances = warehouseIds.length === 0 ? [] : await db.select({
    itemId: stockBalanceTable.itemId,
    warehouseId: stockBalanceTable.warehouseId,
    qtyBase: stockBalanceTable.qty,
    avgCost: stockBalanceTable.avgCost,
  }).from(stockBalanceTable).where(and(
    eq(stockBalanceTable.companyId, companyId),
    inArray(stockBalanceTable.warehouseId, warehouseIds),
  ));
  return { warehouses, items, units, balances };
}