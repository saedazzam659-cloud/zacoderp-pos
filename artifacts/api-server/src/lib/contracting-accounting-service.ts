import { db } from "@workspace/db";
import { createHash } from "node:crypto";
import {
  accountsTable,
  accountingMappingsTable,
  bankAccountsTable,
  cashBoxesTable,
  costCentersTable,
  contractingEventsTable,
  contractingContractBoqLinesTable,
  contractingOwnerContractsTable,
  contractingProjectsTable,
  contractingProgressBillsTable,
  contractingResourcesTable,
  contractingWorkItemsTable,
  contractingSubContractsTable,
  contractingBillDeductionsTable,
  contractingBillAdditionsTable,
  contractingBillLinesTable,
  contractingBillPenaltiesTable,
  contractingBillAttachmentsTable,
  contractingBillWorkflowEventsTable,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  stockBalanceTable,
  unitsTable,
  warehousesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { assertWritableForDate } from "./periodGuard.js";
import { fullAuditFor } from "./journalAudit.js";
import { nextJeSubSequence } from "./sequences.js";
import { canPostDoc, canUnpostDoc } from "./postingRights.js";
import {
  addStockLedgerEntry,
  refreshItemCost,
  readBatchRemaining,
} from "./stockHelpers.js";
import {
  addRational,
  divideRational,
  formatRational,
  multiplyRational,
  parseExactDecimal,
  resolveItemUnitConversion,
  roundQuantity,
  type Rational,
} from "./unitConversion.js";
import { ensureContractingAccountingTables } from "./contracting-accounting-storage.js";
import { ensureContractingBillDetailsTables } from "./contracting-bill-details-service.js";
import { assertBillContractScope } from "./contracting-bill-contracts.js";
import {
  contractingBranchAllowed,
  contractingAdvanceRecoveryOverrideAllowed,
  contractingAdvanceRecoverySnapshotLocked,
  contractingWarehouseError,
} from "./contracting-security.js";
import {
  contractingBillAmounts,
  contractingBillRoleLines,
  authoritativeCumulativeBillAmounts,
  calculateAdvanceRecoveryCents,
  autoRecoveryApplicationIdempotencyKey,
  reverseAccountingLines,
  validateSettlementCap,
} from "./contracting-accounting-math.js";
import { buildContractingBillAdjustmentResult } from "./contracting-bill-adjustments.js";
import { contractingAdjustmentAccountId, getContractingSettings } from "./contracting-settings.js";
import { calculateSignedContractingBillNet } from "./contracting-bill-adjustment-math.js";
import {
  assertNoBoqCertificationDependents,
  recertifyBoqBill,
} from "./contracting-boq-recertification.js";

type Executor = any;
type RequestLike = any;

const n = (value: unknown): number => {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
};
const money = (value: unknown): string => n(value).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
const exact = (value: unknown): Rational => parseExactDecimal(String(value ?? "0"));
const exactStorage = (value: Rational, places = 18): string =>
  roundQuantity(formatRational(value), places, "half_up");
const exactCompare = (a: Rational, b: Rational): number => {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
};
const exactPositive = (value: Rational): boolean => value.numerator > 0n;
const exactQuantity = (value: Rational): string => {
  const stored = exactStorage(value, 18);
  if (exactCompare(parseExactDecimal(stored), value) !== 0) {
    throw failure("الكمية المحوّلة لا يمكن حفظها دون فقدان دقة؛ استخدم كمية/وحدة تعطي كسراً عشرياً حتى 18 منزلة", 422);
  }
  return stored;
};
// stock_balance/stock_ledger are shared legacy inventory tables and remain at
// their existing numeric(…,4) contract.  Do not widen them from a contracting
// route: reject a quantity that would be changed by that boundary, while
// applying the established half-up policy to legacy cost snapshots.
export const legacyInventoryQuantity = (value: Rational): string => {
  const stored = exactStorage(value, 4);
  if (exactCompare(parseExactDecimal(stored), value) !== 0) {
    throw failure("كمية حركة المقاولات تتجاوز دقة المخزون المشتركة (4 منازل عشرية)؛ لا يمكن ترحيلها دون فقدان الدقة", 422);
  }
  return stored;
};
const legacyInventoryCost = (value: Rational): string => exactStorage(value, 4);
const legacyInventoryTotalCost = (value: Rational): string => exactStorage(value, 4);
// Costs in the contracting movement/allocation snapshots use explicit 18/36
// decimal scales.  The shared stock ledger receives its established 4-place
// half-up projection; a weighted layer such as 5/3 remains postable without
// passing through Number.
const exactCost = (value: Rational): string => exactStorage(value, 18);
const exactTotalCost = (value: Rational): string => exactStorage(value, 36);
export function idempotencyFingerprint(payload: Record<string, unknown>): string {
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

if (false) {
/**
 * Settlement posting is the source of payment state. Keep the legacy bill
 * status/paidAmount projection synchronized in the same transaction as the
 * receipt or advance-application row, and never count reversed settlements.
 */
async function refreshBillPaymentState(tx: Executor, companyId: number, billId: number, userId: number | null) {
  const [bill] = await tx.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  ));
  if (!bill) return;
  const settledResult = await tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0) AS paid
      FROM contracting_accounting_settlements
     WHERE company_id = ${companyId}
       AND bill_id = ${billId}
       AND status = 'posted'
       AND kind IN ('bill_receipt', 'bill_payment', 'advance_application')
  `);
  const paid = Math.max(0, n(resultRows(settledResult)[0]?.paid));
  if (!(paid > 0)) return;
  const [additions, deductions, penalties] = await Promise.all([
    tx.select().from(contractingBillAdditionsTable).where(and(
      eq(contractingBillAdditionsTable.companyId, companyId),
      eq(contractingBillAdditionsTable.billId, billId),
    )),
    tx.select().from(contractingBillDeductionsTable).where(and(
      eq(contractingBillDeductionsTable.companyId, companyId),
      eq(contractingBillDeductionsTable.billId, billId),
    )),
    tx.select().from(contractingBillPenaltiesTable).where(and(
      eq(contractingBillPenaltiesTable.companyId, companyId),
      eq(contractingBillPenaltiesTable.billId, billId),
    )),
  ]);
  const signedNet = calculateSignedContractingBillNet({
    rawNetAmount: bill.netAmount,
    additions,
    deductions,
    penalties,
  });
  const net = n(signedNet.adjustedNetAmount);
  const nextStatus = net > 0 && paid + 0.005 < net ? "partially_paid" : "paid";
  const [updated] = await tx.update(contractingProgressBillsTable).set({
    paidAmount: money(paid),
    status: nextStatus,
    paidAt: nextStatus === "paid" ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  )).returning();
  const [latest] = await tx.select({ state: contractingBillWorkflowEventsTable.state })
    .from(contractingBillWorkflowEventsTable)
    .where(and(
      eq(contractingBillWorkflowEventsTable.companyId, companyId),
      eq(contractingBillWorkflowEventsTable.billId, billId),
    ))
    .orderBy(sql`${contractingBillWorkflowEventsTable.createdAt} DESC`, sql`${contractingBillWorkflowEventsTable.id} DESC`)
    .limit(1);
  if (latest?.state !== nextStatus) {
    await tx.insert(contractingBillWorkflowEventsTable).values({
      companyId,
      projectId: updated?.projectId ?? bill.projectId,
      billId,
      state: nextStatus,
      action: "accounting_settlement",
      note: nextStatus === "paid" ? "تم إغلاق المستخلص بالسداد المحاسبي" : "تم تحديث السداد المحاسبي",
      userId,
    });
  }
}
}
/**
 * Settlement posting is the source of payment state. Keep the legacy bill
 * status/paidAmount projection synchronized in the same transaction as the
 * receipt or advance-application row, and never count reversed settlements.
 */
async function refreshBillPaymentState(tx: Executor, companyId: number, billId: number, userId: number | null) {
  const [bill] = await tx.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  ));
  if (!bill) return;
  const settledResult = await tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0) AS paid
      FROM contracting_accounting_settlements
     WHERE company_id = ${companyId}
       AND bill_id = ${billId}
       AND status = 'posted'
       AND kind IN ('bill_receipt', 'bill_payment', 'advance_application')
  `);
  const paid = Math.max(0, n(resultRows(settledResult)[0]?.paid));
  const [additions, deductions, penalties] = await Promise.all([
    tx.select().from(contractingBillAdditionsTable).where(and(
      eq(contractingBillAdditionsTable.companyId, companyId),
      eq(contractingBillAdditionsTable.billId, billId),
    )),
    tx.select().from(contractingBillDeductionsTable).where(and(
      eq(contractingBillDeductionsTable.companyId, companyId),
      eq(contractingBillDeductionsTable.billId, billId),
    )),
    tx.select().from(contractingBillPenaltiesTable).where(and(
      eq(contractingBillPenaltiesTable.companyId, companyId),
      eq(contractingBillPenaltiesTable.billId, billId),
    )),
  ]);
  const signedNet = calculateSignedContractingBillNet({
    rawNetAmount: bill.netAmount,
    additions,
    deductions,
    penalties,
  });
  const net = n(signedNet.adjustedNetAmount);
  // A reversed payment can bring the posted settlement total back to zero.
  // That must restore the bill to approved rather than leaving a fully-paid
  // projection behind (and thereby blocking the next legitimate settlement).
  const nextStatus = paid <= 0.005
    ? "approved"
    : net > 0 && paid + 0.005 < net ? "partially_paid" : "paid";
  const [updated] = await tx.update(contractingProgressBillsTable).set({
    paidAmount: money(paid),
    status: nextStatus,
    paidAt: nextStatus === "paid" ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProgressBillsTable.id, billId),
    eq(contractingProgressBillsTable.companyId, companyId),
  )).returning();
  const [latest] = await tx.select({ state: contractingBillWorkflowEventsTable.state })
    .from(contractingBillWorkflowEventsTable)
    .where(and(
      eq(contractingBillWorkflowEventsTable.companyId, companyId),
      eq(contractingBillWorkflowEventsTable.billId, billId),
    ))
    .orderBy(sql`${contractingBillWorkflowEventsTable.createdAt} DESC`, sql`${contractingBillWorkflowEventsTable.id} DESC`)
    .limit(1);
  if (latest?.state !== nextStatus) {
    await tx.insert(contractingBillWorkflowEventsTable).values({
      companyId,
      projectId: updated?.projectId ?? bill.projectId,
      billId,
      state: nextStatus,
      action: "accounting_settlement",
      note: nextStatus === "paid"
        ? "تم إغلاق المستخلص بالسداد المحاسبي"
        : nextStatus === "approved"
          ? "تم عكس التسوية وإعادة المستخلص إلى معتمد"
          : "تم تحديث السداد المحاسبي",
      userId,
    });
  }
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
): Promise<{ id: number; qty: number; avgCost: number; qtyExact: string; avgCostExact: string } | null> {
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
  return row ? {
    id: Number(row.id),
    qty: n(row.qty),
    avgCost: n(row.avg_cost),
    qtyExact: String(row.qty ?? "0"),
    avgCostExact: String(row.avg_cost ?? "0"),
  } : null;
}

/** Lock every existing valuation-layer row for the bucket before deriving a
 * pick plan.  stock_balance is only an aggregate concurrency guard; the
 * positive ledger rows are the actual source layers used by FIFO/FEFO. */
async function lockContractingStockLayers(
  tx: Executor,
  companyId: number,
  itemId: number,
  warehouseId: number,
): Promise<void> {
  await tx.execute(sql`
    SELECT id
      FROM stock_ledger
     WHERE company_id = ${companyId}
       AND item_id = ${itemId}
       AND warehouse_id = ${warehouseId}
     ORDER BY id ASC
     FOR UPDATE
  `);
}

type ExactPick = {
  batchNumber: string | null;
  expiryDate: string | null;
  takeQty: Rational;
  costPrice: Rational;
};

/**
 * Allocate from the existing stock_ledger valuation layers without converting
 * PostgreSQL numerics through JavaScript Number.  The public stock helper
 * still supplies the canonical FIFO/FEFO order; raw aliases added there keep
 * the persisted quantity exact to the movement's 18-place scale.
 */
export function allocateContractingPicks(
  batches: Awaited<ReturnType<typeof readBatchRemaining>>,
  requestedQty: Rational,
  movementDate: string,
  selectedBatchNumber?: string | null,
  selectedExpiryDate?: string | null,
): ExactPick[] {
  const picks: ExactPick[] = [];
  let remaining = requestedQty;
  for (const batch of batches) {
    if (!exactPositive(remaining)) break;
    if (selectedBatchNumber !== undefined &&
        (batch.batchNumber ?? null) !== (selectedBatchNumber ?? null)) continue;
    if (selectedExpiryDate !== undefined &&
        (batch.expiryDate ?? null) !== (selectedExpiryDate ?? null)) continue;
    // Expired layers are never an available source.  This applies to both
    // FIFO and FEFO; FEFO still determines the order among valid layers.
    if (batch.expiryDate && batch.expiryDate < movementDate) continue;
    const available = exact(batch.remainingRaw ?? String(batch.remaining));
    if (!exactPositive(available)) continue;
    const take = exactCompare(available, remaining) < 0 ? available : remaining;
    const inboundQty = exact(batch.inboundQtyRaw ?? String(batch.inboundQty));
    const inboundCost = exact(batch.inboundCostRaw ?? String(batch.inboundCost));
    if (!exactPositive(inboundQty)) continue;
    picks.push({
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      takeQty: take,
      costPrice: divideRational(inboundCost, inboundQty),
    });
    remaining = addRational(remaining, { numerator: -take.numerator, denominator: take.denominator });
  }
  if (exactPositive(remaining)) {
    const label = selectedBatchNumber
      ? ` للتشغيلة ${selectedBatchNumber}`
      : "";
    throw failure(
      `الكمية المتاحة غير منتهية الصلاحية لا تكفي${label}؛ لا يجوز صرف مخزون منتهي أو غير مُثبت التكلفة`,
      400,
    );
  }
  return picks;
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
    retentionEnabled: row.retention_enabled,
    retentionPercent: row.retention_percent,
    retentionCapPercent: row.retention_cap_percent,
    retentionAmount: row.retention_amount,
    previousPaid: row.previous_paid,
    dueAmount: row.due_amount,
    vatPercent: row.vat_percent,
    vatAmount: row.vat_amount,
    netAmount: row.net_amount,
    advanceRecoveryEnabled: row.advance_recovery_enabled,
    advanceRecoveryPercent: row.advance_recovery_percent,
    advanceRecoveryMethod: row.advance_recovery_method,
    advanceRecoveryFixedAmount: row.advance_recovery_fixed_amount,
    advanceRecoveryStartProgressPercent: row.advance_recovery_start_progress_percent,
    advanceRecoveryRequestedAmount: row.advance_recovery_requested_amount,
    advanceRecoveryAmount: row.advance_recovery_amount,
    advanceRecoveryRemainingBefore: row.advance_recovery_remaining_before,
    advanceRecoveryRemainingAfter: row.advance_recovery_remaining_after,
    advanceRecoveryContractAdvanceAmount: row.advance_recovery_contract_advance_amount,
    advanceRecoveryTotalPreviouslyRecovered: row.advance_recovery_total_previously_recovered,
    advanceRecoveryOverrideAmount: row.advance_recovery_override_amount,
    advanceRecoveryOverrideReason: row.advance_recovery_override_reason,
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
export async function certifyBillAmounts(tx: Executor, companyId: number, bill: any, options: { persist?: boolean; lock?: boolean } = {}): Promise<any> {
  // Validate the complete directional relationship before locking the
  // selected contract.  The old check below only verified one id and would
  // accept opposite-direction links or an incoming contractor from another
  // contract.
  await assertBillContractScope(tx, companyId, bill, { requireSelection: true });
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
    SELECT id, value, contract_type, parent_contract_id
      FROM ${sql.raw(contractTable)}
     WHERE id = ${contractId}
       AND company_id = ${companyId}
       AND project_id = ${bill.projectId}
      ${options.lock === false ? sql`` : sql`FOR UPDATE`}
  `);
  const lockedContract = resultRows(contract)[0];
  if (!lockedContract) throw failure("العقد المرتبط بالمستخلص غير موجود في نفس الشركة والمشروع", 422);
  let adjustedContractValue = n(lockedContract.value);
  if (bill.direction === "outgoing") {
    const baseId = ["change_order", "addendum"].includes(String(lockedContract.contract_type))
      ? Number(lockedContract.parent_contract_id ?? lockedContract.id)
      : Number(lockedContract.id);
    const baseResult = await tx.execute(sql`
      SELECT value
        FROM contracting_owner_contracts
       WHERE id = ${baseId}
         AND company_id = ${companyId}
         AND project_id = ${bill.projectId}
    `);
    const childrenResult = await tx.execute(sql`
      SELECT COALESCE(SUM(value), 0) AS value
        FROM contracting_owner_contracts
       WHERE company_id = ${companyId}
         AND project_id = ${bill.projectId}
         AND parent_contract_id = ${baseId}
         AND contract_type IN ('change_order', 'addendum')
         AND status = 'approved'
    `);
    adjustedContractValue = n(resultRows(baseResult)[0]?.value ?? lockedContract.value)
      + n(resultRows(childrenResult)[0]?.value);
  }

   const contractColumn = bill.direction === "incoming" ? "subcontractor_contract_id" : "owner_contract_id";
   const oppositeContractColumn = bill.direction === "incoming" ? "owner_contract_id" : "subcontractor_contract_id";
  const priorResult = await tx.execute(sql`
    SELECT
      COALESCE(MAX(gross_amount), 0) AS prior_gross,
        COALESCE(SUM(retention_amount), 0) AS prior_retention
      FROM contracting_progress_bills
     WHERE company_id = ${companyId}
       AND project_id = ${bill.projectId}
       AND direction = ${bill.direction}
       AND ${sql.raw(contractColumn)} = ${contractId}
        AND ${sql.raw(oppositeContractColumn)} IS NULL
       AND id <> ${bill.id}
        AND (bill_date < ${bill.billDate} OR (bill_date = ${bill.billDate} AND id < ${bill.id}))
       AND status IN ('approved', 'posted', 'partially_paid', 'paid')
       AND reversal_journal_entry_id IS NULL
  `);
  const prior = resultRows(priorResult)[0] ?? {};
  const detailResult = await tx.execute(sql`
    SELECT COUNT(*) AS line_count, COALESCE(SUM(current_value), 0) AS current_value
    FROM contracting_bill_lines
    WHERE company_id = ${companyId} AND project_id = ${bill.projectId} AND bill_id = ${bill.id}
  `);
  const detail = resultRows(detailResult)[0];
  const grossAmount = Number(detail?.line_count ?? 0) > 0
    ? money(n(prior.prior_gross) + n(detail.current_value))
    : bill.grossAmount;
  const amounts = authoritativeCumulativeBillAmounts({
    grossAmount,
    adjustedContractValue,
    retentionEnabled: bill.retentionEnabled,
    retentionPercent: bill.retentionPercent ?? 0,
    retentionCapPercent: bill.retentionCapPercent,
    vatPercent: bill.vatPercent ?? 15,
    priorGrossAmount: prior.prior_gross ?? 0,
    priorRetentionAmount: prior.prior_retention ?? 0,
  });
  const progressPercent = adjustedContractValue > 0 ? money(n(amounts.grossAmount) / adjustedContractValue * 100) : "0.00";
  if (options.persist !== false) await tx.update(contractingProgressBillsTable).set({
    grossAmount: amounts.grossAmount,
    previousPaid: amounts.previousPaid,
    retentionAmount: amounts.retentionAmount,
    dueAmount: amounts.dueAmount,
    vatAmount: amounts.vatAmount,
    netAmount: amounts.netAmount,
    progressPercent,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProgressBillsTable.id, bill.id),
    eq(contractingProgressBillsTable.companyId, companyId),
  ));
  return { ...bill, ...amounts, progressPercent, id: bill.id };
}

/**
 * A zero-certification certificate records physical execution without
 * creating a zero-value journal. It is intentionally narrow: every monetary
 * period amount and every current certified line value must be zero while at
 * least one BOQ line records positive execution. Cumulative gross may include
 * previously certified periods and is deliberately not used for this check.
 */
export async function isNonfinancialBoqCertificate(
  tx: Executor,
  companyId: number,
  bill: any,
): Promise<boolean> {
  if (
    n(bill.dueAmount) !== 0
    || n(bill.vatAmount) !== 0
    || n(bill.netAmount) !== 0
    || n(bill.paidAmount) !== 0
  ) return false;
  const result = await tx.execute(sql`
    SELECT
      COALESCE(SUM(current_qty), 0)::numeric AS physical_qty,
      COALESCE(SUM(current_value), 0)::numeric
        AS certified_value
      FROM contracting_bill_lines
     WHERE company_id = ${companyId}
       AND project_id = ${bill.projectId}
       AND bill_id = ${bill.id}
       AND boq_line_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM contracting_bill_additions a
         WHERE a.company_id = ${companyId} AND a.bill_id = ${bill.id} AND a.amount <> 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM contracting_bill_deductions d
         WHERE d.company_id = ${companyId} AND d.bill_id = ${bill.id} AND d.amount <> 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM contracting_bill_penalties p
         WHERE p.company_id = ${companyId} AND p.bill_id = ${bill.id} AND p.amount <> 0
       )
  `);
  const row = resultRows(result)[0];
  return n(row?.physical_qty) > 0 && n(row?.certified_value) === 0;
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
  direction: "outgoing" | "incoming",
  receivableOrPayable: number,
) {
  return buildContractingBillAdjustmentResult(
    tx,
    companyId,
    { ...bill, direction },
    map,
    receivableOrPayable,
  );
}

function appendBillDetailLines(
  lines: Array<{ accountId: number; debit: string; credit: string; description: string; costCenter?: string | null }>,
  details: Awaited<ReturnType<typeof billDetailAdjustments>>,
): Array<{ accountId: number; debit: string; credit: string; description: string; costCenter?: string | null }> {
  if (details.total <= 0) return lines;
  return [...lines, ...details.journalLines];
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

function billLines(
  bill: any,
  map: Map<string, number>,
  configuredRetentionAccount: number | null = null,
): {
  accountId: number; debit: string; credit: string; description: string;
}[] {
  const amount = contractingBillAmounts(bill);
  const roleLines = contractingBillRoleLines(bill);
  if (bill.direction === "outgoing") {
    const ar = map.get("receivable");
    const ret = map.get("retention_receivable") ?? configuredRetentionAccount;
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
  const ret = map.get("retention_payable") ?? configuredRetentionAccount;
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

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function centsBig(value: unknown): bigint {
  const raw = String(value ?? "0").trim();
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const result = BigInt(whole || "0") * 100n + BigInt((fraction + "00").slice(0, 2) || "0");
  return negative ? -result : result;
}

function centsText(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

async function lockedAdvanceSources(
  tx: Executor,
  companyId: number,
  bill: any,
): Promise<any[]> {
  const isOutgoing = bill.direction === "outgoing";
  const result = await tx.execute(sql`
    SELECT *
      FROM contracting_accounting_settlements
     WHERE company_id = ${companyId}
       AND project_id = ${bill.projectId}
       AND kind IN ('advance_receipt', 'advance_payment')
       AND direction = ${bill.direction}
       AND status = 'posted'
       AND amount > applied_amount
       AND ${isOutgoing
         ? sql`owner_contract_id = ${Number(bill.ownerContractId)}
               AND subcontractor_contract_id IS NULL`
         : sql`subcontractor_contract_id = ${Number(bill.subcontractorContractId)}
               AND owner_contract_id IS NULL`}
     ORDER BY settlement_date ASC, id ASC
     FOR UPDATE
  `);
  return resultRows(result);
}

/**
 * Advance recovery is a posting exception, not a general bill-edit right.
 * Reuse the existing document posting permission so admins and users with an
 * explicit posting grant can request one, while an ordinary editor cannot.
 */
export function canOverrideAdvanceRecovery(req: RequestLike, direction: "outgoing" | "incoming"): boolean {
  const user = req?.authUser;
  return contractingAdvanceRecoveryOverrideAllowed(user);
}

/**
 * A historical journal marker alone does not freeze a reopened submitted
 * bill: unapproval retains the original JE trace while recording its
 * reversal. A reversal state itself remains immutable.
 */
export function isAdvanceRecoverySnapshotLocked(bill: any): boolean {
  return contractingAdvanceRecoverySnapshotLocked(bill);
}

function recoveryContractTable(direction: "outgoing" | "incoming"): string {
  return direction === "incoming" ? "contracting_sub_contracts" : "contracting_owner_contracts";
}

async function liveAdvanceRecoveryContract(
  executor: Executor,
  companyId: number,
  projectId: number,
  direction: "outgoing" | "incoming",
  contractId: number,
  lock = false,
): Promise<any> {
  const row = await executor.execute(sql`
    SELECT id, advance_payment, advance_recovery_enabled,
           advance_recovery_percent, advance_recovery_method,
           advance_recovery_fixed_amount,
           advance_recovery_start_progress_percent,
           value, contract_type, parent_contract_id,
           retention_enabled, retention_percent, retention_cap_percent,
           vat_percent
      FROM ${sql.raw(recoveryContractTable(direction))}
     WHERE id = ${contractId}
       AND company_id = ${companyId}
       AND project_id = ${projectId}
     ${lock ? sql`FOR UPDATE` : sql``}
  `);
  const contract = resultRows(row)[0];
  if (!contract) throw failure("العقد المرتبط بالمستخلص غير موجود في نفس الشركة والمشروع", 422);
  const method = String(contract.advance_recovery_method ?? "percentage");
  if (method !== "percentage" && method !== "fixed") {
    throw failure("طريقة استرداد السلفة في العقد غير صالحة", 409);
  }
  return {
    enabled: booleanValue(contract.advance_recovery_enabled),
    percent: String(contract.advance_recovery_percent ?? "0"),
    method,
    fixedAmount: String(contract.advance_recovery_fixed_amount ?? "0"),
    startProgressPercent: String(contract.advance_recovery_start_progress_percent ?? "0"),
    contractAdvanceAmount: String(contract.advance_payment ?? "0"),
    value: String(contract.value ?? "0"),
    contractType: String(contract.contract_type ?? "main"),
    parentContractId: contract.parent_contract_id == null ? null : Number(contract.parent_contract_id),
    retentionEnabled: contract.retention_enabled == null ? true : booleanValue(contract.retention_enabled),
    retentionPercent: String(contract.retention_percent ?? "5"),
    retentionCapPercent: contract.retention_cap_percent == null ? null : String(contract.retention_cap_percent),
    vatPercent: String(contract.vat_percent ?? "15"),
  };
}

async function previewApprovedBase(
  executor: Executor,
  companyId: number,
  projectId: number,
  bill: any,
  contractId: number,
  billDate: string,
): Promise<{ priorGross: string; priorRetention: string; adjustedContractValue: string }> {
  const contractTable = bill?.direction === "incoming"
    ? "contracting_sub_contracts"
    : "contracting_owner_contracts";
  const contract = await executor.execute(sql`
    SELECT value, contract_type, parent_contract_id
      FROM ${sql.raw(contractTable)}
     WHERE id = ${contractId} AND company_id = ${companyId} AND project_id = ${projectId}
  `);
  const row = resultRows(contract)[0];
  if (!row) throw failure("العقد المرتبط بالمستخلص غير موجود في نفس الشركة والمشروع", 422);
  let adjustedContractValue = n(row.value);
  if (bill?.direction !== "incoming") {
    const baseId = ["change_order", "addendum"].includes(String(row.contract_type))
      ? Number(row.parent_contract_id ?? contractId)
      : contractId;
    const base = await executor.execute(sql`
      SELECT value FROM contracting_owner_contracts
       WHERE id = ${baseId} AND company_id = ${companyId} AND project_id = ${projectId}
    `);
    const children = await executor.execute(sql`
      SELECT COALESCE(SUM(value), 0) AS value
        FROM contracting_owner_contracts
       WHERE company_id = ${companyId} AND project_id = ${projectId}
         AND parent_contract_id = ${baseId}
         AND contract_type IN ('change_order', 'addendum')
         AND status = 'approved'
    `);
    adjustedContractValue = n(resultRows(base)[0]?.value ?? row.value)
      + n(resultRows(children)[0]?.value);
  }
  const contractColumn = bill?.direction === "incoming"
    ? "subcontractor_contract_id"
    : "owner_contract_id";
  const opposite = bill?.direction === "incoming"
    ? "owner_contract_id"
    : "subcontractor_contract_id";
  const prior = await executor.execute(sql`
    SELECT COALESCE(MAX(gross_amount), 0) AS prior_gross,
           COALESCE(SUM(retention_amount), 0) AS prior_retention
      FROM contracting_progress_bills
     WHERE company_id = ${companyId} AND project_id = ${projectId}
       AND direction = ${bill?.direction}
       AND ${sql.raw(contractColumn)} = ${contractId}
       AND ${sql.raw(opposite)} IS NULL
       AND ${bill?.id ? sql`id <> ${bill.id} AND` : sql``}
       (bill_date < ${billDate} OR (bill_date = ${billDate} AND id < ${Number(bill?.id ?? 2147483647)}))
       AND status IN ('approved', 'posted', 'partially_paid', 'paid')
       AND reversal_journal_entry_id IS NULL
  `);
  const priorRow = resultRows(prior)[0] ?? {};
  return {
    priorGross: String(priorRow.prior_gross ?? "0"),
    priorRetention: String(priorRow.prior_retention ?? "0"),
    adjustedContractValue: adjustedContractValue.toFixed(2),
  };
}

async function previewSignedAdjustments(
  executor: Executor,
  companyId: number,
  billId: number | null | undefined,
  rawNetAmount: string,
): Promise<string> {
  if (!billId) return rawNetAmount;
  const [additions, deductions, penalties] = await Promise.all([
    executor.execute(sql`SELECT amount, NULL::text AS kind FROM contracting_bill_additions WHERE company_id = ${companyId} AND bill_id = ${billId}`),
    executor.execute(sql`SELECT amount, kind FROM contracting_bill_deductions WHERE company_id = ${companyId} AND bill_id = ${billId}`),
    executor.execute(sql`SELECT amount, NULL::text AS kind FROM contracting_bill_penalties WHERE company_id = ${companyId} AND bill_id = ${billId}`),
  ]);
  const signed = calculateSignedContractingBillNet({
    rawNetAmount,
    additions: resultRows(additions),
    deductions: resultRows(deductions),
    penalties: resultRows(penalties),
  });
  return signed.adjustedNetAmount;
}

async function advanceRecoveryBalances(
  executor: Executor,
  companyId: number,
  bill: { projectId: number; direction: string; ownerContractId?: number | null; subcontractorContractId?: number | null },
): Promise<{ actualAdvanceRemaining: string; totalPreviouslyRecovered: string }> {
  const contractId = bill.direction === "outgoing"
    ? Number(bill.ownerContractId ?? 0)
    : Number(bill.subcontractorContractId ?? 0);
  const sources = await executor.execute(sql`
    SELECT
      COALESCE(SUM(amount - applied_amount), 0)::numeric AS remaining
    FROM contracting_accounting_settlements
    WHERE company_id = ${companyId}
      AND project_id = ${bill.projectId}
      AND direction = ${bill.direction}
      AND kind IN ('advance_receipt', 'advance_payment')
      AND status = 'posted'
      AND ${bill.direction === "outgoing"
        ? sql`owner_contract_id = ${contractId} AND subcontractor_contract_id IS NULL`
        : sql`subcontractor_contract_id = ${contractId} AND owner_contract_id IS NULL`}
  `);
  const applications = await executor.execute(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS recovered
      FROM contracting_accounting_settlements
     WHERE company_id = ${companyId}
       AND project_id = ${bill.projectId}
       AND direction = ${bill.direction}
       AND kind = 'advance_application'
       AND status = 'posted'
       AND ${bill.direction === "outgoing"
         ? sql`owner_contract_id = ${contractId} AND subcontractor_contract_id IS NULL`
         : sql`subcontractor_contract_id = ${contractId} AND owner_contract_id IS NULL`}
  `);
  return {
    actualAdvanceRemaining: String(resultRows(sources)[0]?.remaining ?? "0"),
    totalPreviouslyRecovered: String(resultRows(applications)[0]?.recovered ?? "0"),
  };
}

function advanceRecoverySnapshot(bill: any): any {
  const progress = String(bill.progressPercent ?? "0");
  const start = String(bill.advanceRecoveryStartProgressPercent ?? "0");
  const enabled = booleanValue(bill.advanceRecoveryEnabled);
  const currentWork = Math.max(0, n(bill.grossAmount) - n(bill.previousPaid));
  const netDue = Math.max(0, n(bill.netAmount));
  const recovery = String(bill.advanceRecoveryAmount ?? "0");
  const before = String(bill.advanceRecoveryRemainingBefore ?? "0");
  const after = String(bill.advanceRecoveryRemainingAfter ?? "0");
  return {
    enabled,
    startReached: Number(progress) >= Number(start),
    eligible: enabled && Number(progress) >= Number(start) && currentWork > 0,
    progressPercent: progress,
    startProgressPercent: start,
    advanceRecoveryPercent: String(bill.advanceRecoveryPercent ?? "0"),
    method: String(bill.advanceRecoveryMethod ?? "percentage"),
    fixedAmount: String(bill.advanceRecoveryFixedAmount ?? "0"),
    contractAdvanceAmount: String(bill.advanceRecoveryContractAdvanceAmount ?? "0"),
    totalPreviouslyRecovered: String(bill.advanceRecoveryTotalPreviouslyRecovered ?? "0"),
    outstandingContractualAmount: String(
      Math.max(
        0,
        n(bill.advanceRecoveryContractAdvanceAmount) - n(bill.advanceRecoveryTotalPreviouslyRecovered),
      ).toFixed(2),
    ),
    currentCertifiedWorkBeforeVat: currentWork.toFixed(2),
    actualAdvanceRemaining: before,
    netDue: netDue.toFixed(2),
    requestedRecoveryAmount: String(bill.advanceRecoveryRequestedAmount ?? "0"),
    recoveryAmount: recovery,
    advanceRecoveryAmount: recovery,
    remainingAdvanceAfter: after,
    remainingAfterRecovery: after,
  };
}

/**
 * Read-only authoritative calculation shared by the preview endpoint and
 * bill-details summary. It deliberately never writes a bill or a settlement.
 */
export async function getAdvanceRecoveryPreview(input: {
  companyId: number;
  projectId: number;
  direction: "outgoing" | "incoming";
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  billDate: string;
  billId?: number | null;
  currentCertifiedWorkBeforeVat?: number | string | null;
  progressPercent?: number | string | null;
  netDue?: number | string | null;
  retentionEnabled?: boolean | null;
  retentionPercent?: number | string | null;
  retentionCapPercent?: number | string | null;
  vatPercent?: number | string | null;
  overrideAmount?: number | string | null;
  overrideReason?: string | null;
  overrideFieldsPresent?: boolean;
  req?: RequestLike;
}) {
  await ensureContractingAccountingTables();
  const project = await projectFor(db, input.companyId, input.projectId);
  if (!project) throw failure("المشروع غير موجود", 404);
  assertProjectBranchAccess(input.req, project.branchId);
  if (input.overrideFieldsPresent && !canOverrideAdvanceRecovery(input.req, input.direction)) {
    throw failure("ليس لديك صلاحية طلب استرداد سلفة استثنائياً", 403);
  }

  let bill: any = null;
  if (input.billId != null) {
    const rows = await db.execute(sql`
      SELECT * FROM contracting_progress_bills
       WHERE id = ${Number(input.billId)}
         AND company_id = ${input.companyId}
         AND project_id = ${input.projectId}
    `);
    bill = camelBill(resultRows(rows)[0]);
    if (!bill) throw failure("المستخلص غير موجود في نفس المشروع والشركة", 404);
    if (bill.direction !== input.direction) throw failure("اتجاه المستخلص لا يطابق طلب المعاينة", 422);
    const expectedContract = input.direction === "outgoing"
      ? Number(bill.ownerContractId ?? 0)
      : Number(bill.subcontractorContractId ?? 0);
    const requestedContract = input.direction === "outgoing"
      ? Number(input.ownerContractId ?? 0)
      : Number(input.subcontractorContractId ?? 0);
    if (expectedContract !== requestedContract) {
      throw failure("العقد المحدد لا يطابق عقد المستخلص", 422);
    }
  }
  const contractId = input.direction === "outgoing"
    ? Number(input.ownerContractId ?? bill?.ownerContractId ?? 0)
    : Number(input.subcontractorContractId ?? bill?.subcontractorContractId ?? 0);
  if (!Number.isInteger(contractId) || contractId <= 0) throw failure("يجب تحديد عقد المالك أو عقد الباطن", 422);
  const locked = bill && isAdvanceRecoverySnapshotLocked(bill);
  if (locked) {
    const snapshot = advanceRecoverySnapshot(bill);
    return {
      ...snapshot,
      billDate: String(bill.billDate),
      canOverride: canOverrideAdvanceRecovery(input.req, input.direction),
      overrideAmount: bill.advanceRecoveryOverrideAmount == null
        ? null : String(bill.advanceRecoveryOverrideAmount),
      overrideReason: bill.advanceRecoveryOverrideReason ?? null,
      source: bill.advanceRecoveryOverrideAmount == null ? "snapshot" : "override",
    };
  }
  const policy = await liveAdvanceRecoveryContract(
    db,
    input.companyId,
    input.projectId,
    input.direction,
    contractId,
  );
  const previewBase = await previewApprovedBase(
    db,
    input.companyId,
    input.projectId,
    { direction: input.direction, id: bill?.id },
    contractId,
    input.billDate,
  );

  const balances = await advanceRecoveryBalances(db, input.companyId, {
    projectId: input.projectId,
    direction: input.direction,
    ownerContractId: input.ownerContractId ?? bill?.ownerContractId,
    subcontractorContractId: input.subcontractorContractId ?? bill?.subcontractorContractId,
  });
  const currentWork = input.currentCertifiedWorkBeforeVat
    ?? (bill ? Math.max(0, n(bill.grossAmount) - n(bill.previousPaid)) : "0");
  const cumulativeGross = (n(previewBase.priorGross) + n(currentWork)).toFixed(2);
  const rawAmounts = authoritativeCumulativeBillAmounts({
    grossAmount: cumulativeGross,
    adjustedContractValue: previewBase.adjustedContractValue,
    retentionEnabled: input.retentionEnabled ?? bill?.retentionEnabled ?? policy.retentionEnabled,
    retentionPercent: input.retentionPercent ?? bill?.retentionPercent ?? policy.retentionPercent,
    retentionCapPercent: input.retentionCapPercent ?? bill?.retentionCapPercent ?? policy.retentionCapPercent,
    vatPercent: input.vatPercent ?? bill?.vatPercent ?? policy.vatPercent,
    priorGrossAmount: previewBase.priorGross,
    priorRetentionAmount: previewBase.priorRetention,
  });
  const adjustedNetBeforePaid = await previewSignedAdjustments(
    db,
    input.companyId,
    bill?.id ?? null,
    rawAmounts.netAmount,
  );
  const derivedNetDue = Math.max(
    0,
    n(adjustedNetBeforePaid) - n(bill?.paidAmount ?? "0"),
  ).toFixed(2);
  const progress = input.progressPercent
    ?? (n(previewBase.adjustedContractValue) > 0
      ? ((n(cumulativeGross) / n(previewBase.adjustedContractValue)) * 100).toFixed(2)
      : "0.00");
  const netDue = input.netDue ?? derivedNetDue;
  const overrideAmount = input.overrideFieldsPresent
    ? input.overrideAmount ?? null
    : bill?.advanceRecoveryOverrideAmount ?? null;
  const overrideReason = input.overrideFieldsPresent
    ? input.overrideReason ?? null
    : bill?.advanceRecoveryOverrideReason ?? null;
  if (
    input.overrideFieldsPresent
    && overrideAmount == null
    && String(overrideReason ?? "").trim() !== ""
  ) {
    throw failure("لا يمكن إرسال سبب استرداد استثنائي دون مبلغ", 422);
  }
  if (overrideAmount != null && String(overrideReason ?? "").trim() === "") {
    throw failure("سبب استرداد السلفة الاستثنائي مطلوب", 422);
  }
  const policyResult = calculateAdvanceRecoveryCents({
    enabled: policy.enabled,
    progressPercent: progress,
    startProgressPercent: policy.startProgressPercent,
    advanceRecoveryPercent: policy.percent,
    method: policy.method,
    fixedAmount: policy.fixedAmount,
    contractAdvanceAmount: policy.contractAdvanceAmount,
    totalPreviouslyRecovered: balances.totalPreviouslyRecovered,
    currentCertifiedWorkBeforeVat: currentWork,
    actualAdvanceRemaining: balances.actualAdvanceRemaining,
    netDue,
    overrideAmount,
  });
  return {
    ...policyResult,
    billDate: input.billDate,
    cumulativeGrossAmount: rawAmounts.grossAmount,
    priorApprovedGrossAmount: previewBase.priorGross,
    derivedNetDue,
    canOverride: canOverrideAdvanceRecovery(input.req, input.direction),
    overrideAmount: overrideAmount == null ? null : String(overrideAmount),
    overrideReason: overrideReason == null ? null : String(overrideReason),
    source: overrideAmount == null ? "contract" : "override",
  };
}

async function applyAdvanceTx(input: {
  tx: Executor;
  companyId: number;
  source: any;
  bill: any;
  amount: string;
  netAmountOverride?: string;
  userId: number | null;
  req: RequestLike;
  applicationOrigin: "manual" | "auto_recovery";
}) {
  const amountCents = centsBig(input.amount);
  if (amountCents <= 0n) throw failure("مبلغ تطبيق السلفة يجب أن يكون أكبر من صفر");
  const sourceAvailable = centsBig(input.source.amount) - centsBig(input.source.applied_amount);
  if (amountCents > sourceAvailable) {
    throw failure("مبلغ تطبيق السلفة يتجاوز الرصيد الفعلي للسلفة بعد الترحيل", 409);
  }
  const settled = await input.tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS total
      FROM contracting_accounting_settlements
     WHERE company_id = ${input.companyId}
       AND bill_id = ${input.bill.id}
       AND status = 'posted'
       AND kind IN ('bill_receipt', 'bill_payment', 'advance_application')
  `);
  const billPaidCents = centsBig(resultRows(settled)[0]?.total ?? "0");
  const netCents = centsBig(input.netAmountOverride ?? input.bill.netAmount);
  if (billPaidCents + amountCents > netCents) {
    throw failure("تطبيق استرداد السلفة يتجاوز صافي المستخلص المتبقي بعد التسويات والمدفوعات", 409);
  }
  const map = await mappings(input.tx, input.companyId, "contracting_advance_application");
  const outgoing = input.bill.direction === "outgoing";
  const settings = await getContractingSettings(input.companyId);
  if (!Array.isArray(settings.adjustmentTypes) || !settings.adjustmentTypes.includes("advance_recovery")) {
    throw failure("استرداد الدفعة المقدمة معطل من إعدادات المقاولات");
  }
  const configuredRecoveryAccount = contractingAdjustmentAccountId(settings, "advance_recovery");
  const debit = outgoing
    ? configuredRecoveryAccount ?? map.get("advance_liability")
    : map.get("payable");
  const credit = outgoing
    ? map.get("receivable")
    : configuredRecoveryAccount ?? map.get("advance_asset");
  if (!debit || !credit) throw failure("أكمل ربط حسابات تطبيق السلف قبل الترحيل");
  const applicationDate = today();
  const jeNumber = await nextJeNumber(
    input.companyId,
    "contracting_advance_application",
    applicationDate,
    input.userId,
  );
  const project = await projectFor(input.tx, input.companyId, input.bill.projectId);
  const jeId = await insertJournal(input.tx, input.companyId, {
    docNumber: jeNumber,
    date: applicationDate,
    branchId: project?.branchId,
    description: `استرداد سلفة تلقائي على مستخلص ${input.bill.billNumber}`,
    entryType: "contracting_advance_application",
    lines: [
      {
        accountId: debit,
        debit: money(input.amount),
        credit: "0.00",
        description: input.applicationOrigin === "auto_recovery" ? "استرداد سلفة تلقائي" : "تخفيض السلفة",
        costCenter: `contracting-project:${input.bill.projectId}`,
      },
      {
        accountId: credit,
        debit: "0.00",
        credit: money(input.amount),
        description: "تخفيض ذمم المستخلص",
        costCenter: `contracting-project:${input.bill.projectId}`,
      },
    ],
    req: input.req,
  });
  const inserted = await input.tx.execute(sql`
    INSERT INTO contracting_accounting_settlements
      (company_id, project_id, bill_id, owner_contract_id, subcontractor_contract_id,
       kind, direction, amount, applied_amount,
       settlement_date, journal_entry_id, source_settlement_id,
       idempotency_key, idempotency_payload_hash, application_origin, notes, created_by)
    VALUES (
      ${input.companyId}, ${input.bill.projectId}, ${input.bill.id},
      ${outgoing ? Number(input.bill.ownerContractId) : null},
      ${outgoing ? null : Number(input.bill.subcontractorContractId)},
      'advance_application', ${input.bill.direction}, ${money(input.amount)},
      ${money(input.amount)}, ${applicationDate}, ${jeId}, ${Number(input.source.id)},
       ${input.applicationOrigin === "auto_recovery"
         ? autoRecoveryApplicationIdempotencyKey(input.bill.id, jeId, input.source.id, input.amount)
         : null},
      ${idempotencyFingerprint({
        billId: input.bill.id,
        sourceSettlementId: Number(input.source.id),
        amount: input.amount,
        origin: input.applicationOrigin,
      })},
      ${input.applicationOrigin}, ${input.applicationOrigin === "auto_recovery" ? "استرداد سلفة تلقائي" : "تطبيق سلفة على المستخلص"},
      ${input.userId}
    )
    RETURNING *
  `);
  await input.tx.execute(sql`
    UPDATE contracting_accounting_settlements
       SET applied_amount = applied_amount + ${money(input.amount)},
           updated_at = NOW()
     WHERE company_id = ${input.companyId}
       AND id = ${Number(input.source.id)}
  `);
  const row = resultRows(inserted)[0];
  await addAudit(input.tx, {
    companyId: input.companyId,
    projectId: input.bill.projectId,
    billId: input.bill.id,
    settlementId: Number(row.id),
    action: input.applicationOrigin === "auto_recovery" ? "advance_recovery" : "advance_application",
    originalJournalEntryId: jeId,
    amount: Number(input.amount),
    metadata: { sourceSettlementId: Number(input.source.id), applicationOrigin: input.applicationOrigin },
    userId: input.userId,
  });
  return row;
}

async function autoRecoverAdvanceTx(input: {
  tx: Executor;
  companyId: number;
  bill: any;
  detailAdjustments: { adjustedNetAmount: number };
  userId: number | null;
  req: RequestLike;
}) {
  const sources = await lockedAdvanceSources(input.tx, input.companyId, input.bill);
  const remainingCents = sources.reduce(
    (sum: bigint, source: any) => sum + centsBig(source.amount) - centsBig(source.applied_amount),
    0n,
  );
  const priorGrossResult = await input.tx.execute(sql`
    SELECT COALESCE(MAX(gross_amount), 0)::numeric AS gross
      FROM contracting_progress_bills
     WHERE company_id = ${input.companyId}
       AND project_id = ${input.bill.projectId}
       AND direction = ${input.bill.direction}
       AND id <> ${input.bill.id}
       AND status IN ('approved', 'posted', 'partially_paid', 'paid')
       AND reversal_journal_entry_id IS NULL
       AND (bill_date < ${input.bill.billDate}
            OR (bill_date = ${input.bill.billDate} AND id < ${input.bill.id}))
       AND ${input.bill.direction === "outgoing"
         ? sql`owner_contract_id = ${Number(input.bill.ownerContractId)}
               AND subcontractor_contract_id IS NULL`
         : sql`subcontractor_contract_id = ${Number(input.bill.subcontractorContractId)}
               AND owner_contract_id IS NULL`}
  `);
  const priorGross = centsBig(resultRows(priorGrossResult)[0]?.gross ?? "0");
  const currentWork = centsBig(input.bill.grossAmount) - priorGross;
  // Existing bill payments are already settled and cannot be recovered again.
  // Keep the preview and approval paths on the same outstanding-net basis.
  const netDue = centsBig(input.detailAdjustments.adjustedNetAmount)
    - centsBig(input.bill.paidAmount ?? "0");
  const recoveredResult = await input.tx.execute(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS recovered
      FROM contracting_accounting_settlements
     WHERE company_id = ${input.companyId}
       AND project_id = ${input.bill.projectId}
       AND direction = ${input.bill.direction}
       AND kind = 'advance_application'
       AND status = 'posted'
       AND ${input.bill.direction === "outgoing"
         ? sql`owner_contract_id = ${Number(input.bill.ownerContractId)}
               AND subcontractor_contract_id IS NULL`
         : sql`subcontractor_contract_id = ${Number(input.bill.subcontractorContractId)}
               AND owner_contract_id IS NULL`}
  `);
  const totalPreviouslyRecovered = String(resultRows(recoveredResult)[0]?.recovered ?? "0");
  const overrideAmount = input.bill.advanceRecoveryOverrideAmount == null
    ? null
    : String(input.bill.advanceRecoveryOverrideAmount);
  const overrideReason = input.bill.advanceRecoveryOverrideReason == null
    ? null
    : String(input.bill.advanceRecoveryOverrideReason);
  if (overrideAmount != null) {
    if (!canOverrideAdvanceRecovery(input.req, input.bill.direction)) {
      throw failure("ليس لديك صلاحية طلب استرداد سلفة استثنائياً", 403);
    }
    if (!overrideReason?.trim()) throw failure("سبب استرداد السلفة الاستثنائي مطلوب", 422);
  }
  const policy = calculateAdvanceRecoveryCents({
    enabled: booleanValue(input.bill.advanceRecoveryEnabled),
    progressPercent: input.bill.progressPercent ?? "0",
    startProgressPercent: input.bill.advanceRecoveryStartProgressPercent ?? "0",
    advanceRecoveryPercent: input.bill.advanceRecoveryPercent ?? "0",
    method: input.bill.advanceRecoveryMethod ?? "percentage",
    fixedAmount: input.bill.advanceRecoveryFixedAmount ?? "0",
    contractAdvanceAmount: input.bill.advanceRecoveryContractAdvanceAmount ?? "0",
    totalPreviouslyRecovered,
    currentCertifiedWorkBeforeVat: centsText(currentWork < 0n ? 0n : currentWork),
    actualAdvanceRemaining: centsText(remainingCents < 0n ? 0n : remainingCents),
    netDue: centsText(netDue < 0n ? 0n : netDue),
    overrideAmount,
  });
  await input.tx.update(contractingProgressBillsTable).set({
    advanceRecoveryEnabled: booleanValue(input.bill.advanceRecoveryEnabled),
    advanceRecoveryPercent: String(input.bill.advanceRecoveryPercent ?? "0"),
    advanceRecoveryMethod: String(input.bill.advanceRecoveryMethod ?? "percentage"),
    advanceRecoveryFixedAmount: String(input.bill.advanceRecoveryFixedAmount ?? "0"),
    advanceRecoveryStartProgressPercent: String(input.bill.advanceRecoveryStartProgressPercent ?? "0"),
    advanceRecoveryContractAdvanceAmount: String(input.bill.advanceRecoveryContractAdvanceAmount ?? "0"),
    advanceRecoveryRequestedAmount: policy.requestedRecoveryAmount,
    advanceRecoveryAmount: policy.recoveryAmount,
    advanceRecoveryRemainingBefore: policy.actualAdvanceRemaining,
    advanceRecoveryRemainingAfter: policy.remainingAdvanceAfter,
    advanceRecoveryTotalPreviouslyRecovered: policy.totalPreviouslyRecovered,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProgressBillsTable.id, input.bill.id),
    eq(contractingProgressBillsTable.companyId, input.companyId),
  ));
  let remainingToApply = centsBig(policy.recoveryAmount);
  const applications: any[] = [];
  for (const source of sources) {
    if (remainingToApply <= 0n) break;
    const available = centsBig(source.amount) - centsBig(source.applied_amount);
    const amount = available < remainingToApply ? available : remainingToApply;
    if (amount <= 0n) continue;
    applications.push(await applyAdvanceTx({
      tx: input.tx,
      companyId: input.companyId,
      source,
      bill: input.bill,
      amount: centsText(amount),
       // applyAdvanceTx checks the full bill settlement cap (including the
       // already-paid amount), while policy.netDue is the outstanding slice.
       netAmountOverride: centsText(centsBig(policy.netDue) + centsBig(input.bill.paidAmount ?? "0")),
      userId: input.userId,
      req: input.req,
      applicationOrigin: "auto_recovery",
    }));
    remainingToApply -= amount;
    source.applied_amount = centsText(centsBig(source.applied_amount) + amount);
  }
  if (overrideAmount != null) {
    await addAudit(input.tx, {
      companyId: input.companyId,
      projectId: input.bill.projectId,
      billId: input.bill.id,
      action: "advance_recovery_override",
      amount: Number(policy.recoveryAmount),
      metadata: { amount: overrideAmount, reason: overrideReason },
      userId: input.userId,
    });
  }
  return { policy, applications };
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
    assertProjectBranchAccess(input.req, project.branchId);
    if (locked.status === "reversed") {
      throw failure("المستخلص الأصلي عُكس؛ اعتمد مسودة التصحيح الجديدة", 409);
    }
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
      if (await isNonfinancialBoqCertificate(tx, input.companyId, locked)) {
        return { ...locked, idempotentReplay: true };
      }
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
    await recertifyBoqBill(tx, input.companyId, locked);
    Object.assign(locked, await certifyBillAmounts(tx, input.companyId, locked));
    // Unapproved drafts follow the live contract. Approval is the boundary:
    // lock/read the current policy and persist the exact snapshot used by the
    // settlement flow below. Contract edits after this point cannot rewrite
    // posted history.
    const recoveryContractId = locked.direction === "outgoing"
      ? Number(locked.ownerContractId ?? 0)
      : Number(locked.subcontractorContractId ?? 0);
    const recoveryPolicy = await liveAdvanceRecoveryContract(
      tx,
      input.companyId,
      locked.projectId,
      locked.direction,
      recoveryContractId,
      true,
    );
    Object.assign(locked, {
      advanceRecoveryEnabled: recoveryPolicy.enabled,
      advanceRecoveryPercent: recoveryPolicy.percent,
      advanceRecoveryMethod: recoveryPolicy.method,
      advanceRecoveryFixedAmount: recoveryPolicy.fixedAmount,
      advanceRecoveryStartProgressPercent: recoveryPolicy.startProgressPercent,
      advanceRecoveryContractAdvanceAmount: recoveryPolicy.contractAdvanceAmount,
    });
    if (
      locked.advanceRecoveryOverrideAmount != null
      && !canOverrideAdvanceRecovery(input.req, locked.direction)
    ) {
      throw failure("ليس لديك صلاحية طلب استرداد سلفة استثنائياً", 403);
    }
    if (await isNonfinancialBoqCertificate(tx, input.companyId, locked)) {
      const [updated] = await tx.update(contractingProgressBillsTable).set({
        status: "approved",
        journalEntryId: null,
        reversalJournalEntryId: null,
        advanceRecoveryEnabled: locked.advanceRecoveryEnabled,
        advanceRecoveryPercent: locked.advanceRecoveryPercent,
        advanceRecoveryMethod: locked.advanceRecoveryMethod,
        advanceRecoveryFixedAmount: locked.advanceRecoveryFixedAmount,
        advanceRecoveryStartProgressPercent: locked.advanceRecoveryStartProgressPercent,
        advanceRecoveryContractAdvanceAmount: locked.advanceRecoveryContractAdvanceAmount,
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
        action: "bill_approved_nonfinancial",
        amount: 0,
        metadata: { physicalExecutionOnly: true },
        userId: input.userId,
      });
      if (locked.advanceRecoveryOverrideAmount != null) {
        await addAudit(tx, {
          companyId: input.companyId,
          projectId: locked.projectId,
          billId: input.billId,
          action: "advance_recovery_override",
          amount: 0,
          metadata: {
            amount: String(locked.advanceRecoveryOverrideAmount),
            reason: String(locked.advanceRecoveryOverrideReason ?? ""),
            appliedAmount: "0.00",
          },
          userId: input.userId,
        });
      }
      await tx.insert(contractingBillWorkflowEventsTable).values({
        companyId: input.companyId,
        projectId: locked.projectId,
        billId: input.billId,
        state: "approved",
        action: "accounting_approve_nonfinancial",
        note: "تم اعتماد شهادة تنفيذ غير مالية بلا قيد صفري",
        userId: input.userId,
      });
      await tx.insert(contractingEventsTable).values({
        companyId: input.companyId,
        projectId: locked.projectId,
        userId: input.userId,
        eventType: "bill_approved",
        title: `اعتماد شهادة تنفيذ ${locked.billNumber}`,
        description: "تم تسجيل التنفيذ الفعلي بلا قيد مالي لأن القيمة المعتمدة صفر",
        severity: "info",
        meta: { nonfinancial: true },
      });
      return { ...(updated ?? locked), idempotentReplay: false };
    }
    const map = await mappings(tx, input.companyId,
      locked.direction === "incoming" ? "contracting_incoming_bill" : "contracting_outgoing_bill");
    const receivableOrPayable = map.get(locked.direction === "outgoing" ? "receivable" : "payable");
    if (!receivableOrPayable) {
      throw failure("حساب الذمم أو المورد غير مربوط لهذا النوع من المستخلص", 422);
    }
    const detailAdjustments = await billDetailAdjustments(
      tx,
      input.companyId,
      locked,
      map,
      locked.direction,
      receivableOrPayable,
    );
    const settings = await getContractingSettings(input.companyId);
    const autoRecovery = await autoRecoverAdvanceTx({
      tx,
      companyId: input.companyId,
      bill: locked,
      detailAdjustments,
      userId: input.userId,
      req: input.req,
    });
    const billCostCenter = await billCostCenterTag(tx, input.companyId, locked.costCenterId);
    const baseLines = billLines(locked, map, settings.retentionAccountId).map((line) => ({
      ...line,
      costCenter: billCostCenter,
    }));
    const lines = appendBillDetailLines(
      baseLines,
      detailAdjustments,
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
      reversalJournalEntryId: null,
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
    if (autoRecovery.applications.length > 0) {
      await refreshBillPaymentState(tx, input.companyId, input.billId, input.userId);
    }
    const [latest] = await tx.select().from(contractingProgressBillsTable).where(and(
      eq(contractingProgressBillsTable.id, input.billId),
      eq(contractingProgressBillsTable.companyId, input.companyId),
    ));
    return { ...(latest ?? updated), idempotentReplay: false };
  });
  return bill;
}

export async function unapproveBill(input: {
  companyId: number;
  billId: number;
  userId: number | null;
  req: RequestLike;
  correction?: boolean;
}) {
  await ensureContractingAccountingTables();
  await ensureContractingBillDetailsTables();
  const reversalDate = today();
  const out = await db.transaction(async (tx) => {
    const bill = await lockBill(tx, input.companyId, input.billId);
    if (!bill) throw failure("المستخلص غير موجود", 404);
    const project = await projectFor(tx, input.companyId, bill.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertProjectBranchAccess(input.req, project.branchId);
    await assertNoBoqCertificationDependents(tx, input.companyId, bill);
    const postingKey = bill.direction === "incoming" ? "ctgIncomingBill" : "ctgOutgoingBill";
    if (!canUnpostDoc(input.req.authUser, postingKey)) {
      throw failure("ليس لديك صلاحية فك ترحيل هذا النوع من المستخلصات", 403);
    }
    if (!["approved", "posted", "partially_paid", "paid"].includes(String(bill.status))) {
      throw failure("المستخلص ليس معتمداً أو مرحّلاً", 409);
    }
    if (!bill.journalEntryId) {
      if (!await isNonfinancialBoqCertificate(tx, input.companyId, bill)) {
        throw failure("لا يمكن فك اعتماد مستخلص مالي بلا قيد", 409);
      }
      const linkedPayments = await tx.execute(sql`
        SELECT id FROM contracting_accounting_settlements
        WHERE company_id = ${input.companyId} AND bill_id = ${bill.id} AND status = 'posted' LIMIT 1
      `);
      if (resultRows(linkedPayments).length) throw failure("يجب عكس التسويات المرتبطة أولًا", 409);
      const [updated] = await tx.update(contractingProgressBillsTable).set({
        status: "submitted", approvedAt: null, approvedByUserId: null, updatedAt: new Date(),
      }).where(and(
        eq(contractingProgressBillsTable.companyId, input.companyId),
        eq(contractingProgressBillsTable.id, bill.id),
      )).returning();
      await addAudit(tx, {
        companyId: input.companyId, projectId: bill.projectId, billId: bill.id,
        action: "bill_unapproved_nonfinancial", amount: 0,
        metadata: { physicalExecutionOnly: true }, userId: input.userId,
      });
      await tx.insert(contractingBillWorkflowEventsTable).values({
        companyId: input.companyId, projectId: bill.projectId, billId: bill.id,
        state: "submitted", action: "accounting_unapprove_nonfinancial",
        note: "فك اعتماد شهادة التنفيذ غير المالية، دون إنشاء قيد صفري", userId: input.userId,
      });
      if (input.correction) return clonePostedCorrectionTx(tx, input, bill, null);
      return { ...updated, reversalJournalEntryId: null, originalJournalEntryId: null };
    }
    const linked = await tx.execute(sql`
      SELECT id FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND bill_id = ${input.billId}
         AND status = 'posted'
         AND NOT (kind = 'advance_application' AND application_origin = 'auto_recovery')
       LIMIT 1
    `);
    if (resultRows(linked).length) {
      throw failure("لا يمكن فك الاعتماد بعد وجود تسوية مرتبطة بالمستخلص", 409);
    }
    const autoApplications = await tx.execute(sql`
      SELECT * FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND bill_id = ${input.billId}
         AND kind = 'advance_application'
         AND application_origin = 'auto_recovery'
         AND status = 'posted'
       ORDER BY id DESC
       FOR UPDATE
    `);
    const autoRows = resultRows(autoApplications);
    if (autoRows.length === 0 && (
      n(bill.paidAmount) > 0
      || bill.status === "paid"
      || bill.status === "partially_paid"
    )) {
      throw failure("لا يمكن فك الاعتماد قبل عكس التسويات والمدفوعات التابعة للمستخلص", 409);
    }
    const [original] = await tx.select().from(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, Number(bill.journalEntryId)),
      eq(journalEntriesTable.companyId, input.companyId),
    ));
    if (!original || original.status !== "posted") {
      throw failure("القيد الأصلي غير مرحّل أو غير موجود", 409);
    }
    for (const application of autoRows) {
      const [applicationJournal] = await tx.select().from(journalEntriesTable).where(and(
        eq(journalEntriesTable.id, Number(application.journal_entry_id)),
        eq(journalEntriesTable.companyId, input.companyId),
      ));
      if (!applicationJournal || applicationJournal.status !== "posted") {
        throw failure("قيد استرداد السلفة التلقائي غير مرحّل أو غير موجود", 409);
      }
      const applicationLines = await tx.select().from(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, applicationJournal.id));
      const applicationReversalNumber = await nextJeNumber(
        input.companyId,
        "contracting_advance_application_reversal",
        reversalDate,
        input.userId,
      );
      const applicationReversalId = await insertJournal(tx, input.companyId, {
        docNumber: applicationReversalNumber,
        date: reversalDate,
        branchId: project.branchId,
        description: `عكس استرداد السلفة التلقائي — المستخلص ${bill.billNumber}`,
        entryType: "contracting_advance_application_reversal",
        lines: reverseAccountingLines(applicationLines).map((reversed, index) => ({
          ...reversed,
          accountId: Number(applicationLines[index].accountId),
          costCenter: applicationLines[index].costCenter,
        })),
        req: input.req,
      });
      await tx.execute(sql`
        UPDATE contracting_accounting_settlements
           SET status = 'reversed',
               reversal_journal_entry_id = ${applicationReversalId},
               updated_at = NOW()
         WHERE company_id = ${input.companyId}
           AND id = ${Number(application.id)}
      `);
      const sourceId = Number(application.source_settlement_id);
      const restoredSource = await tx.execute(sql`
        UPDATE contracting_accounting_settlements
           SET applied_amount = GREATEST(0, applied_amount - ${money(application.amount)}::numeric),
               updated_at = NOW()
         WHERE company_id = ${input.companyId}
           AND id = ${sourceId}
           AND status = 'posted'
         RETURNING id
      `);
      if (!resultRows(restoredSource).length) {
        throw failure("مصدر السلفة التلقائي غير موجود أو غير مرحّل؛ تعذر استعادة رصيده", 409);
      }
      await addAudit(tx, {
        companyId: input.companyId,
        projectId: bill.projectId,
        billId: input.billId,
        settlementId: Number(application.id),
        action: "advance_application_reversed",
        originalJournalEntryId: Number(application.journal_entry_id),
        reversalJournalEntryId: applicationReversalId,
        amount: n(application.amount),
        metadata: { sourceSettlementId: sourceId, applicationOrigin: "auto_recovery" },
        userId: input.userId,
      });
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
      paidAmount: "0.00",
      paidAt: null,
       reversalJournalEntryId: reversalId,
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
    if (input.correction) {
      return clonePostedCorrectionTx(tx, input, bill, reversalId);
    }
    return { ...updated, reversalJournalEntryId: reversalId, originalJournalEntryId: original.id };
  });
  return out;
}

async function clonePostedCorrectionTx(
  tx: Executor,
  input: { companyId: number; userId: number | null },
  source: any,
  reversalJournalEntryId: number | null,
) {
  const [draft] = await tx.insert(contractingProgressBillsTable).values({
    companyId: source.companyId,
    projectId: source.projectId,
    costCenterId: source.costCenterId,
    direction: source.direction,
    contractorId: source.contractorId,
    ownerContractId: source.ownerContractId,
    subcontractorContractId: source.subcontractorContractId,
    billNumber: `${String(source.billNumber).slice(0, 180)}-C${source.id}`,
    billType: source.billType,
    billDate: source.billDate,
    fromDate: source.fromDate,
    toDate: source.toDate,
    progressPercent: source.progressPercent,
    grossAmount: source.grossAmount,
    // A correction is a new draft, but it must inherit the source bill's
    // retention policy snapshot. Company/contract edits must not change the
    // policy used to recertify this historical correction.
    retentionEnabled: source.retentionEnabled,
    retentionPercent: source.retentionPercent,
    retentionCapPercent: source.retentionCapPercent,
    retentionAmount: source.retentionAmount,
    previousPaid: source.previousPaid,
    dueAmount: source.dueAmount,
    vatPercent: source.vatPercent,
    vatAmount: source.vatAmount,
    netAmount: source.netAmount,
    advanceRecoveryEnabled: source.advanceRecoveryEnabled,
    advanceRecoveryPercent: source.advanceRecoveryPercent,
    advanceRecoveryStartProgressPercent: source.advanceRecoveryStartProgressPercent,
    advanceRecoveryRequestedAmount: source.advanceRecoveryRequestedAmount,
    advanceRecoveryAmount: source.advanceRecoveryAmount,
    advanceRecoveryRemainingBefore: source.advanceRecoveryRemainingBefore,
    advanceRecoveryRemainingAfter: source.advanceRecoveryRemainingAfter,
    paidAmount: "0",
    correctionOfId: source.id,
    journalEntryId: null,
    reversalJournalEntryId: null,
    status: "draft",
    approvedByUserId: null,
    approvedAt: null,
    paidAt: null,
    notes: source.notes,
  }).returning();
  if (!draft) throw failure("تعذر إنشاء مسودة التصحيح", 500);

  const lines = await tx.select().from(contractingBillLinesTable).where(and(
    eq(contractingBillLinesTable.companyId, input.companyId),
    eq(contractingBillLinesTable.billId, source.id),
  ));
  if (lines.length) {
    await tx.insert(contractingBillLinesTable).values(lines.map((line: any) => ({
      companyId: line.companyId, projectId: line.projectId, billId: draft.id,
      workItemId: line.workItemId, boqLineId: line.boqLineId,
      unitSnapshot: line.unitSnapshot, unitPriceSnapshot: line.unitPriceSnapshot,
      changeOrderId: line.changeOrderId, changeOrderSubcontractId: line.changeOrderSubcontractId,
      previousQty: line.previousQty, currentQty: line.currentQty, cumulativeQty: line.cumulativeQty,
      previousValue: line.previousValue, currentValue: line.currentValue, cumulativeValue: line.cumulativeValue,
       executionValue: line.executionValue,
       certificationPercent: line.certificationPercent,
       currentExecutionCertifiedValue: line.currentExecutionCertifiedValue,
       priorPendingCertifiedValue: line.priorPendingCertifiedValue,
       certificationReason: line.certificationReason,
       pendingCertificationAllocations: line.pendingCertificationAllocations,
      excessApproved: line.excessApproved, excessApprovalReason: line.excessApprovalReason,
      excessApprovedByUserId: line.excessApprovedByUserId, excessApprovedAt: line.excessApprovedAt,
    })));
  }
  const additions = await tx.select().from(contractingBillAdditionsTable).where(and(
    eq(contractingBillAdditionsTable.companyId, input.companyId),
    eq(contractingBillAdditionsTable.billId, source.id),
  ));
  if (additions.length) {
    await tx.insert(contractingBillAdditionsTable).values(additions.map((row: any) => ({
      companyId: row.companyId, projectId: row.projectId, billId: draft.id,
      additionKey: row.additionKey, calculationType: row.calculationType, rate: row.rate,
      baseType: row.baseType, baseAmount: row.baseAmount, amount: row.amount,
      reason: row.reason, referenceType: row.referenceType, reference: row.reference,
      taxTreatment: row.taxTreatment, accountMappingKey: row.accountMappingKey,
      notes: row.notes, createdByUserId: row.createdByUserId,
    })));
  }
  const deductions = await tx.select().from(contractingBillDeductionsTable).where(and(
    eq(contractingBillDeductionsTable.companyId, input.companyId),
    eq(contractingBillDeductionsTable.billId, source.id),
  ));
  if (deductions.length) {
    await tx.insert(contractingBillDeductionsTable).values(deductions.map((row: any) => ({
      companyId: row.companyId, projectId: row.projectId, billId: draft.id,
      deductionKey: row.deductionKey, kind: row.kind, percentage: row.percentage,
      amount: row.amount, reason: row.reason, reference: row.reference, notes: row.notes,
      createdByUserId: row.createdByUserId,
    })));
  }
  const penalties = await tx.select().from(contractingBillPenaltiesTable).where(and(
    eq(contractingBillPenaltiesTable.companyId, input.companyId),
    eq(contractingBillPenaltiesTable.billId, source.id),
  ));
  if (penalties.length) {
    await tx.insert(contractingBillPenaltiesTable).values(penalties.map((row: any) => ({
      companyId: row.companyId, projectId: row.projectId, billId: draft.id,
      penaltyKey: row.penaltyKey, penaltyType: row.penaltyType, reason: row.reason,
      amount: row.amount, penaltyDate: row.penaltyDate, reference: row.reference,
      notes: row.notes, accountMappingKey: row.accountMappingKey, createdByUserId: row.createdByUserId,
    })));
  }
  const attachments = await tx.select().from(contractingBillAttachmentsTable).where(and(
    eq(contractingBillAttachmentsTable.companyId, input.companyId),
    eq(contractingBillAttachmentsTable.billId, source.id),
  ));
  if (attachments.length) {
    await tx.insert(contractingBillAttachmentsTable).values(attachments.map((row: any) => ({
      companyId: row.companyId, projectId: row.projectId, billId: draft.id,
      category: row.category, filename: row.filename, objectPath: row.objectPath,
      contentType: row.contentType, bytes: row.bytes, uploadedByUserId: row.uploadedByUserId,
    })));
  }
  const [sourceRow] = await tx.update(contractingProgressBillsTable).set({
    status: "reversed",
    reversalJournalEntryId,
    approvedAt: null,
    approvedByUserId: null,
    updatedAt: new Date(),
  }).where(and(
    eq(contractingProgressBillsTable.id, source.id),
    eq(contractingProgressBillsTable.companyId, input.companyId),
  )).returning();
  await tx.insert(contractingBillWorkflowEventsTable).values([
    {
      companyId: source.companyId, projectId: source.projectId, billId: source.id,
      state: "reversed", action: "posted_correction_reversed",
      note: `تم عكس القيد وإنشاء مسودة تصحيح #${draft.id}`, userId: input.userId,
    },
    {
      companyId: draft.companyId, projectId: draft.projectId, billId: draft.id,
      state: "draft", action: "posted_correction_created",
      note: `تصحيح للمستخلص المرحّل #${source.id}`, userId: input.userId,
    },
  ]);
  await addAudit(tx, {
    companyId: input.companyId, projectId: source.projectId, billId: source.id,
    action: "bill_posted_correction", originalJournalEntryId: source.journalEntryId,
    reversalJournalEntryId, amount: n(source.netAmount),
    metadata: { correctionBillId: draft.id }, userId: input.userId,
  });
  await tx.insert(contractingEventsTable).values({
    companyId: input.companyId, projectId: source.projectId, userId: input.userId,
    eventType: "bill_posted_correction", title: `تصحيح مرحّل للمستخلص ${source.billNumber}`,
    description: `القيد العكسي ${reversalJournalEntryId} ومسودة التصحيح ${draft.id}`,
    severity: "warn",
    meta: { sourceBillId: source.id, correctionBillId: draft.id, reversalJournalEntryId },
  });
  return { source: sourceRow, draft, reversalJournalEntryId };
}

/**
 * Correcting a posted bill is deliberately not an edit/unapprove shortcut.
 * First post one immutable reversal for the source JE, then copy the source
 * business data into a new draft. The source row remains auditable and cannot
 * be reused for a second correction.
 */
export async function createPostedCorrection(input: {
  companyId: number;
  billId: number;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  await ensureContractingBillDetailsTables();
  const [source] = await db.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, input.billId),
    eq(contractingProgressBillsTable.companyId, input.companyId),
  ));
  if (!source) throw failure("المستخلص غير موجود", 404);
  if (source.reversalJournalEntryId || source.status === "reversed") {
    throw failure("تم إنشاء تصحيح لهذا المستخلص من قبل", 409);
  }
  if (n(source.paidAmount) > 0 || ["paid", "partially_paid"].includes(String(source.status))) {
    throw failure("لا يمكن تصحيح مستخلص مدفوع قبل عكس التسويات التابعة له", 409);
  }
  const postedSettlements = await db.execute(sql`
    SELECT id FROM contracting_accounting_settlements
     WHERE company_id = ${input.companyId}
       AND bill_id = ${input.billId}
       AND status = 'posted'
     LIMIT 1
  `);
  if (resultRows(postedSettlements).length) {
    throw failure("لا يمكن تصحيح مستخلص له تسويات مرحّلة؛ اعكس التسويات أولاً", 409);
  }
  if (!["approved", "posted"].includes(String(source.status)) || !source.journalEntryId) {
    throw failure("لا يمكن إنشاء تصحيح إلا لمستخلص معتمد بقيد مرحّل", 409);
  }

  // The reversal and every copied detail row run inside one transaction.
  // `unapproveBill` enforces the document-level unpost right itself.
  const correction = await unapproveBill({ ...input, correction: true });
  return correction;
  /*
  const [reversed] = await db.select().from(contractingProgressBillsTable).where(and(
    eq(contractingProgressBillsTable.id, input.billId),
    eq(contractingProgressBillsTable.companyId, input.companyId),
  ));
  if (!reversed) throw failure("تعذر حفظ حالة عكس المستخلص", 500);

  let result;
  try {
    result = await db.transaction(async (tx) => {
    const [draft] = await tx.insert(contractingProgressBillsTable).values({
      companyId: reversed.companyId,
      projectId: reversed.projectId,
      costCenterId: reversed.costCenterId,
      direction: reversed.direction,
      contractorId: reversed.contractorId,
      ownerContractId: reversed.ownerContractId,
      subcontractorContractId: reversed.subcontractorContractId,
      billNumber: `${String(reversed.billNumber).slice(0, 180)}-C${reversed.id}`,
      billType: reversed.billType,
      billDate: reversed.billDate,
      fromDate: reversed.fromDate,
      toDate: reversed.toDate,
      progressPercent: reversed.progressPercent,
      grossAmount: reversed.grossAmount,
      retentionPercent: reversed.retentionPercent,
      retentionAmount: reversed.retentionAmount,
      previousPaid: reversed.previousPaid,
      dueAmount: reversed.dueAmount,
      vatPercent: reversed.vatPercent,
      vatAmount: reversed.vatAmount,
      netAmount: reversed.netAmount,
      paidAmount: "0",
      correctionOfId: reversed.id,
      journalEntryId: null,
      reversalJournalEntryId: null,
      status: "draft",
      approvedByUserId: null,
      approvedAt: null,
      paidAt: null,
      notes: reversed.notes,
    }).returning();
    if (!draft) throw failure("تعذر إنشاء مسودة التصحيح", 500);

    const lines = await tx.select().from(contractingBillLinesTable).where(and(
      eq(contractingBillLinesTable.companyId, input.companyId),
      eq(contractingBillLinesTable.billId, reversed.id),
    ));
    if (lines.length) {
      await tx.insert(contractingBillLinesTable).values(lines.map((line) => ({
        companyId: line.companyId,
        projectId: line.projectId,
        billId: draft.id,
        workItemId: line.workItemId,
        changeOrderId: line.changeOrderId,
        previousQty: line.previousQty,
        currentQty: line.currentQty,
        cumulativeQty: line.cumulativeQty,
        previousValue: line.previousValue,
        currentValue: line.currentValue,
        cumulativeValue: line.cumulativeValue,
        excessApproved: line.excessApproved,
        excessApprovalReason: line.excessApprovalReason,
        excessApprovedByUserId: line.excessApprovedByUserId,
        excessApprovedAt: line.excessApprovedAt,
      })));
    }
    const deductions = await tx.select().from(contractingBillDeductionsTable).where(and(
      eq(contractingBillDeductionsTable.companyId, input.companyId),
      eq(contractingBillDeductionsTable.billId, reversed.id),
    ));
    if (deductions.length) {
      await tx.insert(contractingBillDeductionsTable).values(deductions.map((row) => ({
        companyId: row.companyId, projectId: row.projectId, billId: draft.id,
        deductionKey: row.deductionKey, kind: row.kind, percentage: row.percentage,
        amount: row.amount, reason: row.reason, reference: row.reference,
        notes: row.notes, createdByUserId: row.createdByUserId,
      })));
    }
    const penalties = await tx.select().from(contractingBillPenaltiesTable).where(and(
      eq(contractingBillPenaltiesTable.companyId, input.companyId),
      eq(contractingBillPenaltiesTable.billId, reversed.id),
    ));
    if (penalties.length) {
      await tx.insert(contractingBillPenaltiesTable).values(penalties.map((row) => ({
        companyId: row.companyId, projectId: row.projectId, billId: draft.id,
        penaltyKey: row.penaltyKey, penaltyType: row.penaltyType, reason: row.reason,
        amount: row.amount, penaltyDate: row.penaltyDate, reference: row.reference,
        notes: row.notes, accountMappingKey: row.accountMappingKey,
        createdByUserId: row.createdByUserId,
      })));
    }
    const attachments = await tx.select().from(contractingBillAttachmentsTable).where(and(
      eq(contractingBillAttachmentsTable.companyId, input.companyId),
      eq(contractingBillAttachmentsTable.billId, reversed.id),
    ));
    if (attachments.length) {
      await tx.insert(contractingBillAttachmentsTable).values(attachments.map((row) => ({
        companyId: row.companyId, projectId: row.projectId, billId: draft.id,
        category: row.category, filename: row.filename, objectPath: row.objectPath,
        contentType: row.contentType, bytes: row.bytes, uploadedByUserId: row.uploadedByUserId,
      })));
    }
    const [sourceRow] = await tx.update(contractingProgressBillsTable).set({
      status: "reversed",
      reversalJournalEntryId: Number(reversal.reversalJournalEntryId),
      approvedAt: null,
      approvedByUserId: null,
      updatedAt: new Date(),
    }).where(and(
      eq(contractingProgressBillsTable.id, reversed.id),
      eq(contractingProgressBillsTable.companyId, input.companyId),
    )).returning();
    await tx.insert(contractingBillWorkflowEventsTable).values([
      {
        companyId: reversed.companyId, projectId: reversed.projectId, billId: reversed.id,
        state: "reversed", action: "posted_correction_reversed",
        note: `تم عكس القيد وإنشاء مسودة تصحيح #${draft.id}`, userId: input.userId,
      },
      {
        companyId: draft.companyId, projectId: draft.projectId, billId: draft.id,
        state: "draft", action: "posted_correction_created",
        note: `تصحيح للمستخلص المرحّل #${reversed.id}`, userId: input.userId,
      },
    ]);
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: reversed.projectId,
      billId: reversed.id,
      action: "bill_posted_correction",
      originalJournalEntryId: reversed.journalEntryId,
      reversalJournalEntryId: Number(reversal.reversalJournalEntryId),
      amount: n(reversed.netAmount),
      metadata: { correctionBillId: draft.id },
      userId: input.userId,
    });
    await tx.insert(contractingEventsTable).values({
      companyId: input.companyId,
      projectId: reversed.projectId,
      userId: input.userId,
      eventType: "bill_posted_correction",
      title: `تصحيح مرحّل للمستخلص ${reversed.billNumber}`,
      description: `القيد العكسي ${reversal.reversalJournalEntryId} ومسودة التصحيح ${draft.id}`,
      severity: "warn",
      meta: { sourceBillId: reversed.id, correctionBillId: draft.id, reversalJournalEntryId: reversal.reversalJournalEntryId },
    });
      return { source: sourceRow, draft, reversalJournalEntryId: reversal.reversalJournalEntryId };
    });
  } catch (caught) {
    // The reversal has already been posted. Keep the source immutable even
    // if copying its details fails, so a retry cannot edit the source row.
    await db.update(contractingProgressBillsTable).set({
      status: "reversed",
      reversalJournalEntryId: Number(reversal.reversalJournalEntryId),
      updatedAt: new Date(),
    }).where(and(
      eq(contractingProgressBillsTable.id, reversed.id),
      eq(contractingProgressBillsTable.companyId, input.companyId),
    ));
    throw caught;
  }
  return result;
  */
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
  if (["approved", "posted", "partially_paid", "paid", "reversed"].includes(String(bill.status))) {
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

if (false) {
async function createSettlementRebaseAlternative(input: {
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
    assertProjectBranchAccess(input.req, project.branchId);
    let bill: any = null;
    const requiresBill = input.kind.startsWith("retention_") || input.kind.startsWith("bill_");
    if (input.billId != null) {
      bill = await lockBill(tx, input.companyId, input.billId);
      if (!bill || bill.projectId !== input.projectId) throw failure("المستخلص غير صالح لهذا المشروع");
      if (bill.direction !== details.direction) throw failure("اتجاه التسوية لا يطابق اتجاه المستخلص");
       if (!["approved", "posted", "partially_paid"].includes(String(bill.status)) || !bill.journalEntryId) {
        throw failure("يجب اعتماد وترحيل المستخلص قبل تسوية المستخلص");
      }
      await assertBillContractScope(tx, input.companyId, bill, { requireSelection: true });
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
    if (!bill) {
      await assertBillContractScope(tx, input.companyId, {
        projectId: input.projectId,
        direction: details.direction,
        ownerContractId,
        subcontractorContractId,
        // Standalone subcontractor advances identify their contractor through
        // the selected subcontract, not through a separate payload field.
        contractorId: null,
      }, { requireSelection: true, requireIncomingContractor: false });
    } else if (input.ownerContractId != null || input.subcontractorContractId != null) {
      // A caller may repeat the selected contract for clarity, but an
      // opposite-direction id must still be rejected rather than ignored.
      await assertBillContractScope(tx, input.companyId, {
        projectId: input.projectId,
        direction: details.direction,
        ownerContractId: input.ownerContractId,
        subcontractorContractId: input.subcontractorContractId,
        contractorId: bill.contractorId,
      }, { requireSelection: false, requireIncomingContractor: false });
    }
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
      const [additions, deductions, penalties] = await Promise.all([
        tx.select().from(contractingBillAdditionsTable).where(and(
          eq(contractingBillAdditionsTable.companyId, input.companyId),
          eq(contractingBillAdditionsTable.billId, input.billId!),
        )),
        tx.select().from(contractingBillDeductionsTable).where(and(
          eq(contractingBillDeductionsTable.companyId, input.companyId),
          eq(contractingBillDeductionsTable.billId, input.billId!),
        )),
        tx.select().from(contractingBillPenaltiesTable).where(and(
          eq(contractingBillPenaltiesTable.companyId, input.companyId),
          eq(contractingBillPenaltiesTable.billId, input.billId!),
        )),
      ]);
      const signedNet = calculateSignedContractingBillNet({
        rawNetAmount: bill.netAmount,
        additions,
        deductions,
        penalties,
      });
      const postedBillLedger = await tx.execute(sql`
        SELECT COALESCE(SUM(amount), 0) AS total
          FROM contracting_accounting_settlements
         WHERE company_id = ${input.companyId}
           AND bill_id = ${input.billId}
           AND status = 'posted'
           AND kind IN ('bill_receipt', 'bill_payment', 'advance_application')
      `);
      const cap = validateSettlementCap({
        kind: input.kind as "bill_receipt" | "bill_payment",
        requested: input.amount,
        billNetAmount: signedNet.adjustedNetAmount,
        // paidAmount is a projection of this same posted ledger; never add
        // it to ledger rows or an advance application is counted twice.
        billPaidAmount: n(resultRows(postedBillLedger)[0]?.total),
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
    if (input.billId != null) {
      await refreshBillPaymentState(tx, input.companyId, input.billId, input.userId);
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
    assertProjectBranchAccess(input.req, project.branchId);
    let bill: any = null;
    const requiresBill = input.kind.startsWith("retention_") || input.kind.startsWith("bill_");
    if (input.billId != null) {
      bill = await lockBill(tx, input.companyId, input.billId);
      if (!bill || bill.projectId !== input.projectId) throw failure("المستخلص غير صالح لهذا المشروع");
      if (bill.direction !== details.direction) throw failure("اتجاه التسوية لا يطابق اتجاه المستخلص");
      // A duplicate request can be waiting on this bill lock while the first
      // request advances the bill to paid. Replay before state validation, or
      // that harmless retry would incorrectly fail as an already-paid bill.
      const billLockedReplay = await tx.execute(sql`
        SELECT * FROM contracting_accounting_settlements
         WHERE company_id = ${input.companyId}
           AND idempotency_key = ${input.idempotencyKey}
         LIMIT 1
      `);
      const billReplayRow = resultRows(billLockedReplay)[0];
      if (billReplayRow) {
        assertIdempotentReplay(billReplayRow, payloadHash);
        return { ...billReplayRow, idempotentReplay: true };
      }
       if (!["approved", "posted", "partially_paid"].includes(String(bill.status)) || !bill.journalEntryId) {
        throw failure("يجب اعتماد وترحيل المستخلص قبل تسوية المستخلص");
      }
      await assertBillContractScope(tx, input.companyId, bill, { requireSelection: true });
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
    if (!bill) {
      await assertBillContractScope(tx, input.companyId, {
        projectId: input.projectId,
        direction: details.direction,
        ownerContractId,
        subcontractorContractId,
        // Standalone subcontractor advances identify their contractor through
        // the selected subcontract, not through a separate payload field.
        contractorId: null,
      }, { requireSelection: true, requireIncomingContractor: false });
    } else if (input.ownerContractId != null || input.subcontractorContractId != null) {
      // A caller may repeat the selected contract for clarity, but an
      // opposite-direction id must still be rejected rather than ignored.
      await assertBillContractScope(tx, input.companyId, {
        projectId: input.projectId,
        direction: details.direction,
        ownerContractId: input.ownerContractId,
        subcontractorContractId: input.subcontractorContractId,
        contractorId: bill.contractorId,
      }, { requireSelection: false, requireIncomingContractor: false });
    }
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
    // The preflight lookup above is only a fast replay path. Recheck after the
    // bill/contract locks so two identical concurrent requests cannot both
    // pass the cap calculation and race the unique settlement index.
    const lockedReplay = await tx.execute(sql`
      SELECT * FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND idempotency_key = ${input.idempotencyKey}
       LIMIT 1
    `);
    const replayRow = resultRows(lockedReplay)[0];
    if (replayRow) {
      assertIdempotentReplay(replayRow, payloadHash);
      return { ...replayRow, idempotentReplay: true };
    }
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
      const [additions, deductions, penalties] = await Promise.all([
        tx.select().from(contractingBillAdditionsTable).where(and(
          eq(contractingBillAdditionsTable.companyId, input.companyId),
          eq(contractingBillAdditionsTable.billId, input.billId!),
        )),
        tx.select().from(contractingBillDeductionsTable).where(and(
          eq(contractingBillDeductionsTable.companyId, input.companyId),
          eq(contractingBillDeductionsTable.billId, input.billId!),
        )),
        tx.select().from(contractingBillPenaltiesTable).where(and(
          eq(contractingBillPenaltiesTable.companyId, input.companyId),
          eq(contractingBillPenaltiesTable.billId, input.billId!),
        )),
      ]);
      const signedNet = calculateSignedContractingBillNet({
        rawNetAmount: bill.netAmount,
        additions,
        deductions,
        penalties,
      });
      const postedBillLedger = await tx.execute(sql`
        SELECT COALESCE(SUM(amount), 0) AS total
          FROM contracting_accounting_settlements
         WHERE company_id = ${input.companyId}
           AND bill_id = ${input.billId}
           AND status = 'posted'
           AND kind IN ('bill_receipt', 'bill_payment', 'advance_application')
      `);
      const cap = validateSettlementCap({
        kind: input.kind as "bill_receipt" | "bill_payment",
        requested: input.amount,
        billNetAmount: signedNet.adjustedNetAmount,
        // paidAmount is a projection of this same posted ledger; never add
        // it to ledger rows or an advance application is counted twice.
        billPaidAmount: n(resultRows(postedBillLedger)[0]?.total),
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
    if (input.billId != null) {
      await refreshBillPaymentState(tx, input.companyId, input.billId, input.userId);
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

/**
 * Payment settlements are immutable accounting evidence.  A correction is a
 * separate reversing JE, never a delete or a negative rewrite of the source
 * payment.  This intentionally supports only bill receipts/payments: advances
 * and retention have their own application/release lifecycle and need their
 * own source-balance restoration rules.
 */
export async function reverseBillSettlement(input: {
  companyId: number;
  settlementId: number;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  return db.transaction(async (tx) => {
    // Establish the same lock order used by bill payment and approval:
    // bill -> exact contract -> settlement.  The preliminary read only finds
    // that order; the settlement is re-read FOR UPDATE before any decision.
    // This prevents a payment/recovery writer from racing the paid-state
    // projection and makes two simultaneous reversal requests serialize.
    const target = resultRows(await tx.execute(sql`
      SELECT bill_id, project_id, direction, owner_contract_id,
             subcontractor_contract_id, kind
        FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND id = ${input.settlementId}
    `))[0];
    if (!target) throw failure("تسوية المقاولات غير موجودة", 404);
    if (!["bill_receipt", "bill_payment"].includes(String(target.kind)) || target.bill_id == null) {
      throw failure("عكس هذه التسوية غير مدعوم من مسار عكس دفعات المستخلص", 422);
    }
    const bill = await lockBill(tx, input.companyId, Number(target.bill_id));
    if (!bill || bill.projectId !== Number(target.project_id) || bill.direction !== target.direction) {
      throw failure("المستخلص المرتبط بالتسوية غير صالح", 409);
    }
    const project = await projectFor(tx, input.companyId, bill.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertProjectBranchAccess(input.req, project.branchId);
    const contractId = bill.direction === "outgoing"
      ? Number(bill.ownerContractId ?? 0)
      : Number(bill.subcontractorContractId ?? 0);
    const contractTable = bill.direction === "outgoing"
      ? "contracting_owner_contracts"
      : "contracting_sub_contracts";
    if (!contractId || Number(target.owner_contract_id ?? 0) !== (bill.direction === "outgoing" ? contractId : 0)
      || Number(target.subcontractor_contract_id ?? 0) !== (bill.direction === "incoming" ? contractId : 0)) {
      throw failure("عقد التسوية لا يطابق عقد المستخلص", 409);
    }
    const contract = await tx.execute(sql`
      SELECT id FROM ${sql.raw(contractTable)}
       WHERE company_id = ${input.companyId}
         AND project_id = ${bill.projectId}
         AND id = ${contractId}
       FOR UPDATE
    `);
    if (!resultRows(contract).length) throw failure("العقد المرتبط بالتسوية غير موجود في نفس الشركة والمشروع", 409);
    const locked = await tx.execute(sql`
      SELECT *
        FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND id = ${input.settlementId}
       FOR UPDATE
    `);
    const settlement = resultRows(locked)[0];
    if (!settlement) throw failure("تسوية المقاولات غير موجودة", 404);
    if (!["bill_receipt", "bill_payment"].includes(String(settlement.kind))) {
      throw failure("عكس هذه التسوية غير مدعوم من مسار عكس دفعات المستخلص", 422);
    }
    if (settlement.status === "reversed") {
      return { ...settlement, idempotentReplay: true };
    }
    if (settlement.status !== "posted" || !settlement.journal_entry_id) {
      throw failure("لا يمكن عكس تسوية غير مرحّلة أو بلا قيد", 409);
    }
    if (!canUnpostDoc(input.req?.authUser, "ctgContractingSettlement")) {
      throw failure("ليس لديك صلاحية فك ترحيل هذه التسوية", 403);
    }
    const [original] = await tx.select().from(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, Number(settlement.journal_entry_id)),
      eq(journalEntriesTable.companyId, input.companyId),
    ));
    if (!original || original.status !== "posted") {
      throw failure("قيد التسوية الأصلي غير مرحّل أو غير موجود", 409);
    }
    const originalLines = await tx.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, original.id));
    if (!originalLines.length) throw failure("قيد التسوية الأصلي لا يحتوي على بنود", 409);
    const reversalDate = today();
    const reversalNumber = await nextJeNumber(
      input.companyId,
      "contracting_settlement_reversal",
      reversalDate,
      input.userId,
    );
    const reversalJournalEntryId = await insertJournal(tx, input.companyId, {
      docNumber: reversalNumber,
      date: reversalDate,
      branchId: project.branchId,
      description: `عكس تسوية مقاولات ${settlement.kind} — مشروع #${settlement.project_id}`,
      entryType: "contracting_settlement_reversal",
      lines: reverseAccountingLines(originalLines).map((reversed, index) => ({
        ...reversed,
        accountId: Number(originalLines[index].accountId),
        costCenter: originalLines[index].costCenter,
      })),
      req: input.req,
    });
    const reversed = await tx.execute(sql`
      UPDATE contracting_accounting_settlements
         SET status = 'reversed',
             reversal_journal_entry_id = ${reversalJournalEntryId},
             updated_at = NOW()
       WHERE company_id = ${input.companyId}
         AND id = ${input.settlementId}
       RETURNING *
    `);
    if (settlement.bill_id != null) {
      await refreshBillPaymentState(tx, input.companyId, Number(settlement.bill_id), input.userId);
    }
    const row = resultRows(reversed)[0];
    await addAudit(tx, {
      companyId: input.companyId,
      projectId: Number(settlement.project_id),
      billId: settlement.bill_id == null ? null : Number(settlement.bill_id),
      settlementId: Number(settlement.id),
      action: "bill_settlement_reversed",
      originalJournalEntryId: Number(settlement.journal_entry_id),
      reversalJournalEntryId,
      amount: n(settlement.amount),
      metadata: { kind: settlement.kind, reversalDate },
      userId: input.userId,
    });
    return { ...row, idempotentReplay: false };
  });
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
    const bill = await lockBill(tx, input.companyId, input.billId);
    if (!bill || !["approved", "posted", "partially_paid"].includes(String(bill.status)) || !bill.journalEntryId) {
      throw failure("يجب تطبيق السلفة على مستخلص معتمد وله قيد");
    }
    await assertBillContractScope(tx, input.companyId, bill, { requireSelection: true });
    const billContractId = bill.direction === "outgoing"
      ? Number(bill.ownerContractId ?? 0)
      : Number(bill.subcontractorContractId ?? 0);
    const contractTable = bill.direction === "outgoing"
      ? "contracting_owner_contracts"
      : "contracting_sub_contracts";
    const contract = await tx.execute(sql`
      SELECT id FROM ${sql.raw(contractTable)}
       WHERE company_id = ${input.companyId}
         AND project_id = ${bill.projectId}
         AND id = ${billContractId}
       FOR UPDATE
    `);
    if (!resultRows(contract).length) throw failure("العقد المرتبط بالمستخلص غير موجود");
    const sourceResult = await tx.execute(sql`
      SELECT * FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND id = ${input.settlementId}
       FOR UPDATE
    `);
    const source = resultRows(sourceResult)[0];
    if (!source || source.status !== "posted"
      || !["advance_receipt", "advance_payment"].includes(String(source.kind))) {
      throw failure("السلفة غير موجودة أو غير قابلة للتطبيق", 404);
    }
    if (Number(source.project_id) !== Number(bill.projectId)) {
      throw failure("السلفة والمستخلص لا يتبعان المشروع نفسه");
    }
    await assertBillContractScope(tx, input.companyId, {
      projectId: Number(source.project_id),
      direction: String(source.direction),
      ownerContractId: source.owner_contract_id,
      subcontractorContractId: source.subcontractor_contract_id,
      contractorId: null,
    }, { requireSelection: true, requireIncomingContractor: false });
    assertProjectBranchAccess(input.req, (await projectFor(tx, input.companyId, bill.projectId))?.branchId);
    const sourceDirection = String(source.direction);
    if (sourceDirection !== bill.direction) throw failure("اتجاه السلفة لا يطابق المستخلص");
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
    const postedBillLedger = await tx.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS total
        FROM contracting_accounting_settlements
       WHERE company_id = ${input.companyId}
         AND bill_id = ${input.billId}
         AND status = 'posted'
         AND kind IN ('bill_receipt', 'bill_payment', 'advance_application')
    `);
    const [additions, deductions, penalties] = await Promise.all([
      tx.select().from(contractingBillAdditionsTable).where(and(
        eq(contractingBillAdditionsTable.companyId, input.companyId),
        eq(contractingBillAdditionsTable.billId, input.billId),
      )),
      tx.select().from(contractingBillDeductionsTable).where(and(
        eq(contractingBillDeductionsTable.companyId, input.companyId),
        eq(contractingBillDeductionsTable.billId, input.billId),
      )),
      tx.select().from(contractingBillPenaltiesTable).where(and(
        eq(contractingBillPenaltiesTable.companyId, input.companyId),
        eq(contractingBillPenaltiesTable.billId, input.billId),
      )),
    ]);
    const signedNet = calculateSignedContractingBillNet({
      rawNetAmount: bill.netAmount,
      additions,
      deductions,
      penalties,
    });
    const billCap = validateSettlementCap({
      kind: "bill_payment",
      requested: input.amount,
      billNetAmount: signedNet.adjustedNetAmount,
      // paidAmount is only a projection of this ledger; never add it again.
      billPaidAmount: n(resultRows(postedBillLedger)[0]?.total),
    });
    if (!billCap.ok) throw failure("تطبيق السلفة يتجاوز رصيد المستخلص بعد التسويات والسلف المدفوعة");
    const map = await mappings(tx, input.companyId, "contracting_advance_application");
    const outgoing = bill.direction === "outgoing";
    const settings = await getContractingSettings(input.companyId);
    const configuredRecoveryAccount = contractingAdjustmentAccountId(settings, "advance_recovery");
    const debit = outgoing
      ? configuredRecoveryAccount ?? map.get("advance_liability")
      : map.get("payable");
    const credit = outgoing
      ? map.get("receivable")
      : configuredRecoveryAccount ?? map.get("advance_asset");
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
    await refreshBillPaymentState(tx, input.companyId, input.billId, input.userId);
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

/** Read the existing valuation-layer buckets for the optional lot selector.
 * This is a read-only projection; posting still locks and re-reads the layers
 * inside its transaction, so a stale UI option can only produce a safe
 * validation error, never a wrong-cost movement. */
export async function materialLots(
  companyId: number,
  projectId: number,
  itemId: number,
  warehouseId: number,
  movementDate = today(),
) {
  const project = await projectFor(db, companyId, projectId);
  if (!project) throw failure("المشروع غير موجود", 404);
  const [warehouse] = await db.select({
    id: warehousesTable.id,
    branchId: warehousesTable.branchId,
    isActive: warehousesTable.isActive,
  }).from(warehousesTable).where(and(
    eq(warehousesTable.id, warehouseId),
    eq(warehousesTable.companyId, companyId),
  ));
  if (!warehouse || !warehouse.isActive) throw failure("المخزن غير موجود أو غير نشط");
  const warehouseError = contractingWarehouseError(project.branchId, warehouse.branchId);
  if (warehouseError) {
    throw failure(warehouseError, 403);
  }
  const [item] = await db.select({
    id: itemsTable.id,
    batchTrackingMode: itemsTable.batchTrackingMode,
  }).from(itemsTable).where(and(
    eq(itemsTable.id, itemId),
    eq(itemsTable.companyId, companyId),
    eq(itemsTable.itemType, "stock"),
    eq(itemsTable.status, "active"),
  ));
  if (!item) throw failure("الصنف يجب أن يكون صنف مخزون نشطاً من نفس الشركة");
  const mode = item.batchTrackingMode === "fifo" || item.batchTrackingMode === "fefo"
    ? item.batchTrackingMode
    : null;
  if (!mode) return { mode: "none", lots: [] };
  const rows = await readBatchRemaining(companyId, itemId, warehouseId, mode);
  return {
    mode,
    lots: rows.map((row) => ({
      batchNumber: row.batchNumber,
      expiryDate: row.expiryDate,
      remainingBase: row.remainingRaw ?? String(row.remaining),
      unitCost: row.inboundQtyRaw && row.inboundCostRaw
        ? exactCost(divideRational(exact(row.inboundCostRaw), exact(row.inboundQtyRaw)))
        : "0",
      expired: !!row.expiryDate && row.expiryDate < movementDate,
    })),
  };
}

export async function issueOrReturnMaterial(input: {
  companyId: number;
  projectId: number;
  resourceId?: number | null;
  ownerContractId?: number | null;
  subcontractorContractId?: number | null;
  boqLineId?: number | null;
  /**
   * Explicit posting dimension. undefined = derive from the selected BOQ's
   * execution work item; null = intentionally leave the JE dimension empty.
   * Returns always retain the original issue journal's dimension.
   */
  costCenterId?: number | null;
  itemId: number;
  unitId: number;
  warehouseId: number;
  qty: string | number;
  direction: "issue" | "return";
  movementDate: string;
  sourceMovementId?: number | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  idempotencyKey: string;
  notes?: string | null;
  userId: number | null;
  req: RequestLike;
}) {
  await ensureContractingAccountingTables();
  if (!input.idempotencyKey?.trim()) throw failure("مفتاح العملية مطلوب لمنع الترحيل المكرر");
  const payloadHash = idempotencyFingerprint({
    projectId: input.projectId,
    resourceId: input.resourceId ?? null,
    ownerContractId: input.ownerContractId ?? null,
    subcontractorContractId: input.subcontractorContractId ?? null,
    boqLineId: input.boqLineId ?? null,
    costCenterId: input.costCenterId === undefined ? "__derive__" : input.costCenterId,
    itemId: input.itemId,
    unitId: input.unitId,
    warehouseId: input.warehouseId,
    qty: String(input.qty),
    direction: input.direction,
    movementDate: input.movementDate,
    sourceMovementId: input.sourceMovementId ?? null,
    batchNumber: input.batchNumber === undefined ? "__auto__" : input.batchNumber,
    expiryDate: input.expiryDate === undefined ? "__auto__" : input.expiryDate,
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
    // Serialize the idempotency check itself.  The unique index remains the
    // database backstop, while this lock makes concurrent retries replay the
    // committed movement instead of racing into two stock mutations.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${`contracting-material-idempotency:${input.companyId}:${input.idempotencyKey}`})
      )
    `);
    const txExisting = await tx.execute(sql`
      SELECT * FROM contracting_material_movements
       WHERE company_id = ${input.companyId}
         AND idempotency_key = ${input.idempotencyKey}
       LIMIT 1
    `);
    if (resultRows(txExisting)[0]) {
      const row = resultRows(txExisting)[0];
      assertIdempotentReplay(row, payloadHash);
      return { ...row, idempotentReplay: true };
    }
    const project = await projectFor(tx, input.companyId, input.projectId);
    if (!project) throw failure("المشروع غير موجود", 404);
    assertProjectBranchAccess(input.req, project.branchId);
    const suppliedOwnerContractId = input.ownerContractId ?? null;
    const suppliedSubcontractorContractId = input.subcontractorContractId ?? null;
    const suppliedBoqLineId = input.boqLineId ?? null;
    let boqWorkItemCostCenterId: number | null = null;
    for (const [value, label] of [
      [suppliedOwnerContractId, "عقد المالك"],
      [suppliedSubcontractorContractId, "عقد الباطن"],
      [suppliedBoqLineId, "سطر جدول الكميات"],
    ] as const) {
      if (value != null && (!Number.isInteger(value) || value <= 0)) {
        throw failure(`${label} غير صالح`);
      }
    }
    if (suppliedOwnerContractId != null && suppliedSubcontractorContractId != null) {
      throw failure("لا يمكن ربط حركة المواد بعقد مالك وعقد باطن معاً");
    }
    if (suppliedBoqLineId != null &&
        suppliedOwnerContractId == null && suppliedSubcontractorContractId == null) {
      throw failure("اختر العقد المرتبط قبل اختيار سطر جدول الكميات");
    }
    if (suppliedOwnerContractId != null) {
      const [contract] = await tx.select({ id: contractingOwnerContractsTable.id })
        .from(contractingOwnerContractsTable).where(and(
          eq(contractingOwnerContractsTable.id, suppliedOwnerContractId),
          eq(contractingOwnerContractsTable.companyId, input.companyId),
          eq(contractingOwnerContractsTable.projectId, input.projectId),
        ));
      if (!contract) throw failure("عقد المالك لا يتبع الشركة والمشروع المحددين");
    }
    if (suppliedSubcontractorContractId != null) {
      const [contract] = await tx.select({ id: contractingSubContractsTable.id })
        .from(contractingSubContractsTable).where(and(
          eq(contractingSubContractsTable.id, suppliedSubcontractorContractId),
          eq(contractingSubContractsTable.companyId, input.companyId),
          eq(contractingSubContractsTable.projectId, input.projectId),
        ));
      if (!contract) throw failure("عقد الباطن لا يتبع الشركة والمشروع المحددين");
    }
    if (suppliedBoqLineId != null) {
      const [boqLine] = await tx.select({
        direction: contractingContractBoqLinesTable.direction,
        ownerContractId: contractingContractBoqLinesTable.ownerContractId,
        subcontractorContractId: contractingContractBoqLinesTable.subcontractorContractId,
        workItemCostCenterId: contractingWorkItemsTable.costCenterId,
      }).from(contractingContractBoqLinesTable)
        .innerJoin(contractingWorkItemsTable, and(
          eq(contractingWorkItemsTable.id, contractingContractBoqLinesTable.workItemId),
          eq(contractingWorkItemsTable.companyId, input.companyId),
          eq(contractingWorkItemsTable.projectId, input.projectId),
        )).where(and(
        eq(contractingContractBoqLinesTable.id, suppliedBoqLineId),
        eq(contractingContractBoqLinesTable.companyId, input.companyId),
        eq(contractingContractBoqLinesTable.projectId, input.projectId),
      ));
      const matchesOwner = suppliedOwnerContractId != null &&
        boqLine?.direction === "owner" &&
        Number(boqLine.ownerContractId) === suppliedOwnerContractId;
      const matchesSubcontract = suppliedSubcontractorContractId != null &&
        boqLine?.direction === "subcontract" &&
        Number(boqLine.subcontractorContractId) === suppliedSubcontractorContractId;
      if (!boqLine || (!matchesOwner && !matchesSubcontract)) {
        throw failure("سطر جدول الكميات لا يتبع العقد المحدد");
      }
      boqWorkItemCostCenterId = boqLine.workItemCostCenterId == null
        ? null : Number(boqLine.workItemCostCenterId);
    }
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
    const warehouseError = contractingWarehouseError(project.branchId, warehouse.branchId);
    if (warehouseError) {
      throw failure(warehouseError);
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
    const batchMode = item.batchTrackingMode === "fifo" || item.batchTrackingMode === "fefo"
      ? item.batchTrackingMode
      : "none";
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
    const requestedQty = exact(input.qty);
    if (!exactPositive(requestedQty)) throw failure("الكمية يجب أن تكون أكبر من صفر");
    const requestedQtyBase = multiplyRational(requestedQty, exact(conversion.factor));
    if (!exactPositive(requestedQtyBase)) throw failure("تحويل الوحدة أعطى كمية غير صالحة");
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
    let sourceMovement: any = null;
    let returnPicks: Array<{
      allocationId: number | null;
      sourceLedgerId: number | null;
      batchNumber: string | null;
      expiryDate: string | null;
      takeQty: Rational;
      costPrice: Rational;
    }> = [];
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
      sourceMovement = resultRows(sourceResult)[0];
      if (!sourceMovement || Number(sourceMovement.item_id) !== input.itemId ||
          Number(sourceMovement.warehouse_id) !== input.warehouseId) {
        throw failure("حركة الصرف الأصلية غير صالحة لهذا الإرجاع");
      }
      const sourceOwnerContractId = sourceMovement.owner_contract_id == null
        ? null : Number(sourceMovement.owner_contract_id);
      const sourceSubcontractorContractId = sourceMovement.subcontractor_contract_id == null
        ? null : Number(sourceMovement.subcontractor_contract_id);
      const sourceBoqLineId = sourceMovement.boq_line_id == null
        ? null : Number(sourceMovement.boq_line_id);
      if ((suppliedOwnerContractId != null && suppliedOwnerContractId !== sourceOwnerContractId) ||
          (suppliedSubcontractorContractId != null &&
            suppliedSubcontractorContractId !== sourceSubcontractorContractId) ||
          (suppliedBoqLineId != null && suppliedBoqLineId !== sourceBoqLineId)) {
        throw failure("يجب أن يحتفظ الإرجاع بإسناد العقد وجدول الكميات من حركة الصرف الأصلية");
      }
      const sourceAllocations = await tx.execute(sql`
        SELECT id, source_ledger_id, batch_number, expiry_date, qty_base, unit_cost
          FROM contracting_material_movement_allocations
         WHERE company_id = ${input.companyId}
           AND movement_id = ${input.sourceMovementId}
         ORDER BY id ASC
         FOR UPDATE
      `);
      const allocationRows = resultRows(sourceAllocations);
      if (!allocationRows.length) {
        // Movements posted before per-layer provenance was introduced remain
        // reversible when the item is an unbatched weighted-average item:
        // the original movement is the immutable cost snapshot.  A tracked
        // FIFO/FEFO movement without allocations cannot be reconstructed
        // safely and must be corrected through an inventory adjustment.
        if (batchMode !== "none") {
          throw failure("لا يمكن إرجاع حركة FIFO/FEFO قديمة بلا لقطة تشغيلة؛ أنشئ تصحيحاً مخزونياً مضبوطاً", 409);
        }
        const legacyReturned = await tx.execute(sql`
          SELECT COALESCE(SUM(qty_base), 0)::text AS total
            FROM contracting_material_movements
           WHERE company_id = ${input.companyId}
             AND source_movement_id = ${input.sourceMovementId}
             AND direction = 'return'
             AND status = 'posted'
        `);
        const alreadyReturned = exact(resultRows(legacyReturned)[0]?.total ?? "0");
        const sourceQty = exact(sourceMovement.qty_base);
        const remainingLegacy = addRational(sourceQty, {
          numerator: -alreadyReturned.numerator,
          denominator: alreadyReturned.denominator,
        });
        if (!exactPositive(remainingLegacy) || exactCompare(requestedQtyBase, remainingLegacy) > 0) {
          throw failure("كمية الإرجاع تتجاوز الكمية المتبقية من حركة الصرف الأصلية", 409);
        }
        returnPicks.push({
          allocationId: null,
          sourceLedgerId: null,
          batchNumber: null,
          expiryDate: null,
          takeQty: requestedQtyBase,
          costPrice: exact(sourceMovement.unit_cost),
        });
      } else {
        const returnedRows = await tx.execute(sql`
          SELECT source_allocation_id, SUM(qty_base)::text AS total
            FROM contracting_material_movement_allocations
           WHERE company_id = ${input.companyId}
             AND source_movement_id = ${input.sourceMovementId}
             AND source_allocation_id IS NOT NULL
           GROUP BY source_allocation_id
        `);
        const returnedByAllocation = new Map<number, Rational>(
          resultRows(returnedRows).map((row) => [
            Number(row.source_allocation_id),
            exact(row.total ?? "0"),
          ]),
        );
        let remainingToReturn = requestedQtyBase;
        for (const allocation of allocationRows) {
          if (!exactPositive(remainingToReturn)) break;
          const allocated = exact(allocation.qty_base);
          const alreadyReturned = returnedByAllocation.get(Number(allocation.id))
            ?? exact("0");
          const available = addRational(allocated, {
            numerator: -alreadyReturned.numerator,
            denominator: alreadyReturned.denominator,
          });
          if (!exactPositive(available)) continue;
          if (allocation.expiry_date && String(allocation.expiry_date) < input.movementDate) {
            // Returning the lot into stock would make an expired layer available
            // again.  Require a controlled inventory adjustment instead.
            const requestedAgainstExpired = exactCompare(available, remainingToReturn) < 0
              ? available
              : remainingToReturn;
            if (exactPositive(requestedAgainstExpired)) {
              throw failure(`لا يمكن إرجاع التشغيلة المنتهية ${allocation.batch_number ?? ""} إلى المخزون`, 422);
            }
          }
          const take = exactCompare(available, remainingToReturn) < 0
            ? available
            : remainingToReturn;
          returnPicks.push({
            allocationId: Number(allocation.id),
            sourceLedgerId: allocation.source_ledger_id == null ? null : Number(allocation.source_ledger_id),
            batchNumber: allocation.batch_number ?? null,
            expiryDate: allocation.expiry_date ?? null,
            takeQty: take,
            costPrice: exact(allocation.unit_cost),
          });
          remainingToReturn = addRational(remainingToReturn, {
            numerator: -take.numerator,
            denominator: take.denominator,
          });
        }
        if (exactPositive(remainingToReturn)) {
          throw failure("كمية الإرجاع تتجاوز الكمية المتبقية من حركة الصرف الأصلية", 409);
        }
      }
    }
    const balance = await lockContractingStockBalance(tx, input.companyId, input.itemId, input.warehouseId);
    // Lock actual ledger layers after the aggregate advisory/row lock and
    // before reading the pick plan.  This is the source-of-truth lock for
    // FIFO/FEFO quantities; stock_balance is deliberately never duplicated
    // per lot.
    await lockContractingStockLayers(tx, input.companyId, input.itemId, input.warehouseId);
    const available = exact(balance?.qtyExact ?? "0");
    if (input.direction === "issue" && exactCompare(available, requestedQtyBase) < 0 &&
        (!warehouse.allowNegative || batchMode !== "none")) {
      throw failure(`الرصيد الفعلي لا يكفي: المتاح ${exactStorage(available)}، المطلوب ${exactStorage(requestedQtyBase)}`);
    }
    let issuePicks: ExactPick[] = [];
    if (input.direction === "issue" && batchMode !== "none") {
      const batches = await readBatchRemaining(
        input.companyId,
        input.itemId,
        input.warehouseId,
        batchMode,
        tx,
      );
      issuePicks = allocateContractingPicks(
        batches,
        requestedQtyBase,
        input.movementDate,
        input.batchNumber,
        input.expiryDate,
      );
    } else if (input.direction === "issue") {
      issuePicks = [{
        batchNumber: null,
        expiryDate: null,
        takeQty: requestedQtyBase,
        costPrice: exact(balance?.avgCostExact ?? "0"),
      }];
    }
    const picks = input.direction === "issue"
      ? issuePicks
      : returnPicks;
    // The contracting movement/allocation tables retain 18-place quantities,
    // but the shared stock ledger and balance remain on their existing
    // numeric(…,4) contract.  Refuse a base quantity or split that would be
    // rounded in those shared tables.
    legacyInventoryQuantity(requestedQtyBase);
    for (const pick of picks) legacyInventoryQuantity(pick.takeQty);
    const totalCostExact = picks.reduce(
      (sum, pick) => addRational(sum, multiplyRational(pick.takeQty, pick.costPrice)),
      exact("0"),
    );
    const totalCost = n(exactStorage(totalCostExact, 12));
    const unitCostExact = divideRational(totalCostExact, requestedQtyBase);
    const delta = input.direction === "issue"
      ? { numerator: -requestedQtyBase.numerator, denominator: requestedQtyBase.denominator }
      : requestedQtyBase;
    const oldQty = exact(balance?.qtyExact ?? "0");
    const newQty = addRational(oldQty, delta);
    const mayGoNegative = input.direction === "issue" && batchMode === "none" && warehouse.allowNegative;
    if (!balance || (!mayGoNegative && exactCompare(newQty, { numerator: 0n, denominator: 1n }) < 0)) {
      throw failure("لا يوجد رصيد مخزون قابل للتحديث لهذه الحركة", 409);
    }
    const storedNewQtyText = legacyInventoryQuantity(newQty);
    let newAverage = exact(balance.avgCostExact);
    if (input.direction === "return" && exactPositive(newQty)) {
      const oldValue = multiplyRational(oldQty, exact(balance.avgCostExact));
      const returnValue = totalCostExact;
      newAverage = divideRational(addRational(oldValue, returnValue), newQty);
    }
    {
      await tx.update(stockBalanceTable).set({
        qty: storedNewQtyText,
        avgCost: legacyInventoryCost(newAverage),
        updatedAt: new Date(),
      }).where(and(
        eq(stockBalanceTable.id, balance.id),
        eq(stockBalanceTable.companyId, input.companyId),
        eq(stockBalanceTable.itemId, input.itemId),
        eq(stockBalanceTable.warehouseId, input.warehouseId),
      ));
    }
    const insertedMovement = await tx.execute(sql`
      INSERT INTO contracting_material_movements
        (company_id, project_id, project_branch_id, resource_id,
         owner_contract_id, subcontractor_contract_id, boq_line_id,
         item_id, unit_id, warehouse_id,
         warehouse_branch_id,
         direction, movement_date, qty, qty_base, unit_cost, total_cost,
         source_movement_id, idempotency_key, idempotency_payload_hash, notes, created_by)
      VALUES (
        ${input.companyId}, ${input.projectId}, ${project.branchId ?? null}, ${input.resourceId ?? null},
        ${input.direction === "return" ? sourceMovement.owner_contract_id : suppliedOwnerContractId},
        ${input.direction === "return" ? sourceMovement.subcontractor_contract_id : suppliedSubcontractorContractId},
        ${input.direction === "return" ? sourceMovement.boq_line_id : suppliedBoqLineId},
        ${input.itemId}, ${input.unitId}, ${input.warehouseId},
        ${warehouse.branchId ?? null},
        ${input.direction}, ${input.movementDate}, ${exactQuantity(requestedQty)},
        ${exactQuantity(requestedQtyBase)}, ${exactCost(unitCostExact)}, ${exactTotalCost(totalCostExact)},
        ${input.sourceMovementId ?? null}, ${input.idempotencyKey}, ${payloadHash},
        ${input.notes ?? null}, ${input.userId}
      )
      RETURNING *
    `);
    const movement = resultRows(insertedMovement)[0];
    let runningBalance = oldQty;
    for (const pick of picks) {
      const legacyPickQty = exact(legacyInventoryQuantity(pick.takeQty));
      const pickTotalCost = multiplyRational(pick.takeQty, pick.costPrice);
      runningBalance = input.direction === "issue"
        ? addRational(runningBalance, { numerator: -legacyPickQty.numerator, denominator: legacyPickQty.denominator })
        : addRational(runningBalance, legacyPickQty);
      const ledgerId = await addStockLedgerEntry({
        companyId: input.companyId,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        txDate: input.movementDate,
        txType: input.direction === "issue" ? "goods_delivery" : "goods_receipt",
        qty: input.direction === "issue"
          ? `-${legacyInventoryQuantity(pick.takeQty)}`
          : legacyInventoryQuantity(pick.takeQty),
        costPrice: legacyInventoryCost(pick.costPrice),
        totalCost: input.direction === "issue"
          ? `-${legacyInventoryTotalCost(pickTotalCost)}`
          : legacyInventoryTotalCost(pickTotalCost),
        balanceQty: legacyInventoryQuantity(runningBalance),
        refId: Number(movement.id),
        refType: `contracting_material_${input.direction}`,
        batchNumber: pick.batchNumber,
        expiryDate: pick.expiryDate,
        notes: input.notes ?? undefined,
      }, tx);
      await tx.execute(sql`
        INSERT INTO contracting_material_movement_allocations
          (company_id, movement_id, source_movement_id, source_allocation_id,
           source_ledger_id, item_id, warehouse_id, batch_number, expiry_date,
           qty_base, unit_cost, total_cost)
        VALUES (
          ${input.companyId}, ${Number(movement.id)},
          ${input.direction === "return" ? input.sourceMovementId : null},
          ${input.direction === "return" ? (pick as typeof returnPicks[number]).allocationId : null},
          ${input.direction === "return" ? (pick as typeof returnPicks[number]).sourceLedgerId : ledgerId},
          ${input.itemId}, ${input.warehouseId}, ${pick.batchNumber}, ${pick.expiryDate},
          ${exactQuantity(pick.takeQty)}, ${exactCost(pick.costPrice)},
          ${exactTotalCost(multiplyRational(pick.takeQty, pick.costPrice))}
        )
      `);
    }
    await refreshItemCost(input.companyId, input.itemId, tx);
    const map = await mappings(tx, input.companyId, "contracting_material_movement");
    const inventory = map.get("inventory");
    const wip = map.get("wip");
    if (!inventory || !wip) throw failure("أكمل ربط حساب المخزون وأعمال تحت التنفيذ لحركة مواد المقاولات");
    let journalCostCenter: string | null;
    if (input.direction === "return") {
      const originalCenter = await tx.execute(sql`
        SELECT cost_center
          FROM journal_entry_lines
         WHERE journal_entry_id = ${sourceMovement.journal_entry_id}
         ORDER BY id ASC
         LIMIT 1
      `);
      journalCostCenter = resultRows(originalCenter)[0]?.cost_center ?? null;
    } else {
      const chosenId = input.costCenterId === undefined
        ? boqWorkItemCostCenterId
        : input.costCenterId;
      if (chosenId == null) {
        journalCostCenter = input.costCenterId === null
          ? null
          : `contracting-project:${input.projectId}`;
      } else {
        if (!Number.isInteger(chosenId) || chosenId <= 0) {
          throw failure("مركز تكلفة حركة المواد غير صالح");
        }
        const [center] = await tx.select({
          code: costCentersTable.code,
          isActive: costCentersTable.isActive,
          isPosting: costCentersTable.isPosting,
        }).from(costCentersTable).where(and(
          eq(costCentersTable.id, chosenId),
          eq(costCentersTable.companyId, input.companyId),
        ));
        if (!center || !center.isActive || !center.isPosting) {
          throw failure("مركز تكلفة حركة المواد غير موجود أو غير نشط/ترحيلي");
        }
        journalCostCenter = center.code;
      }
    }
    const jeNumber = await nextJeNumber(input.companyId, "contracting_material", input.movementDate, input.userId);
    const jeId = await insertJournal(tx, input.companyId, {
      docNumber: jeNumber,
      date: input.movementDate,
      branchId: project.branchId,
      description: `${input.direction === "issue" ? "صرف" : "إرجاع"} مواد للمشروع #${input.projectId}`,
      entryType: "contracting_material_movement",
      lines: input.direction === "issue"
        ? [
            { accountId: wip, debit: money(totalCost), credit: "0.00", description: "تكلفة مواد فعلية للمشروع", costCenter: journalCostCenter },
            { accountId: inventory, debit: "0.00", credit: money(totalCost), description: "إخراج من المخزون", costCenter: journalCostCenter },
          ]
        : [
            { accountId: inventory, debit: money(totalCost), credit: "0.00", description: "إرجاع إلى المخزون", costCenter: journalCostCenter },
            { accountId: wip, debit: "0.00", credit: money(totalCost), description: "تخفيض تكلفة مواد المشروع", costCenter: journalCostCenter },
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
      metadata: {
        qtyBase: exactQuantity(requestedQtyBase),
        unitCost: exactCost(unitCostExact),
        balanceQty: storedNewQtyText,
        batchMode,
        allocationCount: picks.length,
        costRounding: "half_up@18",
        totalCostRounding: "half_up@36",
      },
      userId: input.userId,
    });
    return {
      ...movement,
      journal_entry_id: jeId,
      balance_qty: storedNewQtyText,
      idempotentReplay: false,
    };
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
      ? isNull(warehousesTable.branchId)
      : or(
          isNull(warehousesTable.branchId),
          eq(warehousesTable.branchId, project.branchId),
        ),
  ));
  const items = await db.select({
    id: itemsTable.id,
    code: itemsTable.code,
    nameAr: itemsTable.nameAr,
    unitId: itemsTable.unitId,
    batchTrackingMode: itemsTable.batchTrackingMode,
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
  return {
    projectBranchId: project.branchId,
    requiresProjectBranch: project.branchId == null,
    warehouses,
    items,
    units,
    balances,
  };
}
