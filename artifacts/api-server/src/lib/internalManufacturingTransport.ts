import {
  accountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  manufacturingSettingsTable,
  productionCostAllocationsTable,
  productionEventsTable,
  productionOrdersTable,
  stockTransfersTable,
  warehousesTable,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { fullAuditFor } from "./journalAudit.js";
import { nextSequenceNumber } from "./sequences.js";
import { assertWritableForDate } from "./periodGuard.js";
import { getAllowedBranchIds } from "../middleware/auth.js";
import { canAccessModule } from "../middleware/permissions.js";

const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled", "reversed"]);

export const INTERNAL_TRANSPORT_SOURCE_TYPE = "internal_transport";

export function assertInternalDeliveryOrderPermission(req: any, action: "edit" | "post") {
  if (!canAccessModule(req?.authUser, "production", action) &&
      !canAccessModule(req?.authUser, "simple_manufacturing", action)) {
    throw Object.assign(new Error("ربط إذن التسليم يتطلب صلاحية التصنيع المناسبة"), { status: 403 });
  }
}
// Non-serializable test seam: it is intentionally a Symbol on the Express
// request rather than a body/header option, so callers can never choose a
// journal writer. Production always uses the shared journal persistence path.
export const INTERNAL_TRANSPORT_JOURNAL_WRITER = Symbol("internalTransportJournalWriter");
export type InternalTransportJournalWriter = (values: {
  date: string;
  docNumber: string;
  branchId: number | null;
  entryType: string;
  description: string;
  status?: string;
  lines: Array<{ accountId: number; debit?: number; credit?: number; description: string; costCenter?: string | null }>;
}) => Promise<number>;

export function isInternalTransportTerminalOrderStatus(status: unknown): boolean {
  return TERMINAL_ORDER_STATUSES.has(String(status));
}

export function internalTransportLinkIsIdempotent(
  currentOrderId: number | null | undefined,
  activeAllocationOrderId: number | null | undefined,
  targetOrderId: number,
): boolean {
  return currentOrderId === targetOrderId && activeAllocationOrderId === targetOrderId;
}

export function internalTransportAmount(value: unknown): number {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error("مبلغ النقل الداخلي يجب أن يكون رقماً موجباً أو صفراً"), { status: 400 });
  }
  return Number(amount.toFixed(2));
}

export async function validateInternalTransportAccounts(
  q: any,
  companyId: number,
  amount: number,
  expenseAccountId: unknown,
  counterpartAccountId: unknown,
) {
  if (amount === 0) return;
  const expenseId = Number(expenseAccountId);
  const counterpartId = Number(counterpartAccountId);
  if (!Number.isInteger(expenseId) || !Number.isInteger(counterpartId) ||
      expenseId <= 0 || counterpartId <= 0 || expenseId === counterpartId) {
    throw Object.assign(new Error("مبلغ النقل الداخلي يتطلب حساب مصروف وحساب مقابل مختلفين"), { status: 400 });
  }
  const rows = await q.select({
    id: accountsTable.id,
    accountType: accountsTable.accountType,
    isActive: accountsTable.isActive,
    isPosting: accountsTable.isPosting,
  }).from(accountsTable).where(and(
    eq(accountsTable.companyId, companyId),
    inArray(accountsTable.id, [expenseId, counterpartId]),
  ));
  const byId = new Map(rows.map((row: any) => [row.id, row]));
  const expense = byId.get(expenseId);
  const counterpart = byId.get(counterpartId);
  if (!expense || !expense.isActive || !expense.isPosting || expense.accountType !== "expense") {
    throw Object.assign(new Error("حساب مصروف النقل الداخلي يجب أن يكون حساب مصروف نشطاً وقابلاً للترحيل في الشركة"), { status: 400 });
  }
  if (!counterpart || !counterpart.isActive || !counterpart.isPosting) {
    throw Object.assign(new Error("حساب مقابل النقل الداخلي غير موجود أو غير نشط أو غير قابل للترحيل"), { status: 400 });
  }
}

export async function assertInternalTransportEnabledForCapture(
  q: any,
  companyId: number,
  amount: number,
  existingAmount?: number,
) {
  // Disabling the setting prevents a new/changed charge only.  A previously
  // captured draft remains a historical fact that can still be posted.
  if (amount === 0 || amount === existingAmount) return;
  const [settings] = await q.select({
    internalTransportEnabled: manufacturingSettingsTable.internalTransportEnabled,
  }).from(manufacturingSettingsTable).where(eq(manufacturingSettingsTable.companyId, companyId)).limit(1);
  if (!settings?.internalTransportEnabled) {
    throw Object.assign(new Error("تكلفة النقل الداخلي غير مفعلة في إعدادات التصنيع"), { status: 409 });
  }
}

export async function validateInternalTransportOrder(
  q: any,
  companyId: number,
  orderId: number | null,
  warehouseBranchIds: Array<number | null | undefined>,
  req?: any,
) {
  if (orderId == null) return null;
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw Object.assign(new Error("أمر الإنتاج غير صحيح"), { status: 400 });
  }
  const [order] = await q.select({
    id: productionOrdersTable.id,
    status: productionOrdersTable.status,
    branchId: productionOrdersTable.branchId,
    orderNumber: productionOrdersTable.orderNumber,
    issueJournalEntryId: productionOrdersTable.issueJournalEntryId,
  }).from(productionOrdersTable).where(and(
    eq(productionOrdersTable.id, orderId),
    eq(productionOrdersTable.companyId, companyId),
  )).limit(1);
  if (!order) throw Object.assign(new Error("أمر الإنتاج غير موجود في الشركة"), { status: 404 });
  if (isInternalTransportTerminalOrderStatus(order.status)) {
    throw Object.assign(new Error("لا يمكن ربط النقل الداخلي بأمر إنتاج مكتمل أو ملغى أو معكوس"), { status: 409 });
  }
  const allowed = req ? getAllowedBranchIds(req) : null;
  if (allowed !== null && order.branchId !== null && !allowed.includes(order.branchId)) {
    throw Object.assign(new Error("أمر الإنتاج خارج نطاق الفرع المسموح"), { status: 403 });
  }
  if (order.branchId !== null && warehouseBranchIds.some((branchId) =>
    branchId !== null && branchId !== undefined && branchId !== order.branchId,
  )) {
    throw Object.assign(new Error("يجب أن يتبع أمر الإنتاج ومخزنا إذن التسليم نفس الفرع"), { status: 400 });
  }
  return order;
}

async function insertJournal(
  tx: any,
  companyId: number,
  req: any,
  values: {
    date: string;
    docNumber: string;
    branchId: number | null;
    entryType: string;
    description: string;
    status?: string;
    lines: Array<{ accountId: number; debit?: number; credit?: number; description: string; costCenter?: string | null }>;
  },
) {
  const testWriter = req?.[INTERNAL_TRANSPORT_JOURNAL_WRITER] as InternalTransportJournalWriter | undefined;
  if (testWriter) return testWriter(values);
  const posting = values.status ?? "posted";
  const writable = await assertWritableForDate(companyId, values.date, tx);
  if (!writable.ok) throw Object.assign(new Error(writable.reason ?? "الفترة مغلقة"), { status: 423 });
  const journalNumber = await nextSequenceNumber(companyId, "journal_entry", {
    userId: req.authUser?.id ?? null,
    refTable: "journal_entries",
    branchId: values.branchId,
    docDate: values.date,
  }, tx);
  const [entry] = await tx.insert(journalEntriesTable).values({
    companyId,
    branchId: values.branchId,
    // Use the same transaction-aware JE sequence as the production engine;
    // the source number is only the legacy fallback when none is configured.
    docNumber: journalNumber ?? values.docNumber,
    entryDate: values.date,
    currency: "SAR",
    exchangeRate: "1",
    entryType: values.entryType,
    description: values.description,
    status: posting,
    periodId: writable.period?.id ?? null,
    ...fullAuditFor(req, posting),
  }).returning();
  await tx.insert(journalEntryLinesTable).values(values.lines.map((line, sortOrder) => ({
    entryId: entry.id,
    accountId: line.accountId,
    debit: (line.debit ?? 0).toFixed(2),
    credit: (line.credit ?? 0).toFixed(2),
    description: line.description,
    costCenter: line.costCenter ?? null,
    sortOrder,
  })));
  return entry.id;
}

export async function postInternalTransportExpense(
  tx: any,
  companyId: number,
  transfer: any,
  req: any,
  branchId: number | null,
) {
  const amount = internalTransportAmount(transfer.internalTransportAmount);
  if (amount === 0) return null;
  if (transfer.internalTransportJournalEntryId) return Number(transfer.internalTransportJournalEntryId);
  // Older posted deliveries may already own an expense inside the combined
  // stock-transfer JE. Never book that expense a second time.
  if (transfer.status === "posted" && transfer.journalEntryId) {
    return resolveLegacyInternalTransportSource(tx, companyId, transfer);
  }
  await validateInternalTransportAccounts(
    tx, companyId, amount,
    transfer.internalTransportExpenseAccountId,
    transfer.internalTransportCounterpartAccountId,
  );
  const journalId = await insertJournal(tx, companyId, req, {
    date: String(transfer.transferDate).slice(0, 10),
    docNumber: transfer.transferNumber,
    branchId,
    entryType: "internal_transport_expense",
    // This source is not an approval proposal: the delivery owns an actual
    // expense before production may reclassify it.  A draft source JE would
    // make the allocation claim an unposted cost.
    status: "posted",
    description: `تكلفة نقل داخلي ${transfer.transferNumber}`,
    lines: [
      { accountId: Number(transfer.internalTransportExpenseAccountId), debit: amount, description: "مصروف نقل داخلي" },
      { accountId: Number(transfer.internalTransportCounterpartAccountId), credit: amount, description: "الحساب المقابل للنقل الداخلي" },
    ],
  });
  await tx.update(stockTransfersTable).set({ internalTransportJournalEntryId: journalId, updatedAt: new Date() })
    .where(and(eq(stockTransfersTable.id, transfer.id), eq(stockTransfersTable.companyId, companyId)));
  return journalId;
}

export async function resolveLegacyInternalTransportSource(q: any, companyId: number, transfer: any): Promise<number> {
  if (transfer.internalTransportJournalEntryId) return Number(transfer.internalTransportJournalEntryId);
  const amount = internalTransportAmount(transfer.internalTransportAmount);
  const [entry] = transfer.journalEntryId ? await q.select({
    id: journalEntriesTable.id, status: journalEntriesTable.status, entryType: journalEntriesTable.entryType,
  }).from(journalEntriesTable).where(and(
    eq(journalEntriesTable.companyId, companyId), eq(journalEntriesTable.id, transfer.journalEntryId),
  )).limit(1) : [];
  const lines = entry ? await q.select().from(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.entryId, entry.id)) : [];
  const expense = lines.filter((line: any) => line.accountId === transfer.internalTransportExpenseAccountId &&
    String(line.description ?? "").includes("مصروف تسليم داخلي"));
  const counterpart = lines.filter((line: any) => line.accountId === transfer.internalTransportCounterpartAccountId &&
    String(line.description ?? "").includes("مقابل تسليم داخلي"));
  const balance = lines.reduce((sum: number, line: any) => sum + Number(line.debit) - Number(line.credit), 0);
  if (transfer.status !== "posted" || entry?.status !== "posted" || entry?.entryType !== "stock_transfer" ||
      amount <= 0 || expense.length !== 1 || counterpart.length !== 1 ||
      Math.abs(Number(expense[0]?.debit) - amount) > 0.005 || Number(expense[0]?.credit) !== 0 ||
      Math.abs(Number(counterpart[0]?.credit) - amount) > 0.005 || Number(counterpart[0]?.debit) !== 0 ||
      !Number.isFinite(balance) || Math.abs(balance) > 0.005) {
    throw Object.assign(new Error("تعذر إثبات مصروف النقل الداخلي التاريخي من قيد المصدر؛ يلزم مراجعة محاسبية"), { status: 409 });
  }
  return Number(entry.id);
}

function activeTransportAllocation(row: any): boolean {
  return row.snapshotMeta == null || typeof row.snapshotMeta !== "object" ||
    (row.snapshotMeta as any).internalTransportActive !== false;
}

function appendTransportDelta(snapshotMeta: any, journalId: number | null) {
  const previous = Array.isArray(snapshotMeta?.transportDeltaJournalEntryIds)
    ? snapshotMeta.transportDeltaJournalEntryIds.map(Number).filter(Number.isInteger)
    : [];
  return journalId && !previous.includes(journalId) ? [...previous, journalId] : previous;
}

async function lockTransportSource(tx: any, companyId: number, transferId: number) {
  // Production lifecycle already owns (companyId, positive orderId); use a
  // negative transfer id so the source lock is in a separate key domain.
  await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, ${-transferId})`);
}

async function lockOrder(tx: any, companyId: number, orderId: number, req?: any) {
  // This is deliberately the same lock key used by productionStatusHandler.
  // Link/relink cannot race issue, cancellation, completion or reversal.
  await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, ${orderId})`);
  const [order] = await tx.select().from(productionOrdersTable).where(and(
    eq(productionOrdersTable.id, orderId),
    eq(productionOrdersTable.companyId, companyId),
  )).for("update");
  if (!order) throw Object.assign(new Error("أمر الإنتاج غير موجود في الشركة"), { status: 404 });
  const allowed = req ? getAllowedBranchIds(req) : null;
  if (allowed !== null && (order.branchId == null || !allowed.includes(order.branchId))) {
    throw Object.assign(new Error("أمر الإنتاج خارج نطاق الفرع المسموح"), { status: 403 });
  }
  if (isInternalTransportTerminalOrderStatus(order.status)) {
    throw Object.assign(new Error("لا يمكن تعديل تكلفة أمر إنتاج مكتمل أو ملغى أو معكوس"), { status: 409 });
  }
  return order;
}

// Route-level ordering matters: never hold the transfer row while waiting for
// an order lifecycle lock. Preview ownership, acquire sorted order locks, then
// source and transfer locks, and reject a stale preview rather than acquiring
// a newly discovered order lock in the opposite order.
export async function lockInternalTransportMutation(
  tx: any,
  companyId: number,
  transferId: number,
  req: any,
  targetOrderId?: number | null,
) {
  const [preview] = await tx.select().from(stockTransfersTable).where(and(
    eq(stockTransfersTable.id, transferId), eq(stockTransfersTable.companyId, companyId),
  )).limit(1);
  if (!preview) throw Object.assign(new Error("إذن التسليم غير موجود"), { status: 404 });
  if (preview.productionOrderId != null || targetOrderId != null) {
    assertInternalDeliveryOrderPermission(req, "post");
  }
  if (targetOrderId != null && (!Number.isInteger(targetOrderId) || targetOrderId <= 0)) {
    throw Object.assign(new Error("أمر الإنتاج غير صحيح"), { status: 400 });
  }
  const orderIds = [...new Set([preview.productionOrderId, targetOrderId]
    .filter((id): id is number => id != null))].sort((a, b) => a - b);
  for (const orderId of orderIds) await lockOrder(tx, companyId, orderId, req);
  await lockTransportSource(tx, companyId, transferId);
  const [transfer] = await tx.select().from(stockTransfersTable).where(and(
    eq(stockTransfersTable.id, transferId), eq(stockTransfersTable.companyId, companyId),
  )).for("update");
  if (!transfer) throw Object.assign(new Error("إذن التسليم غير موجود"), { status: 404 });
  if (transfer.productionOrderId !== preview.productionOrderId) {
    throw Object.assign(new Error("تغير ربط إذن التسليم بالتزامن؛ أعد تحميله وأعد المحاولة"), { status: 409 });
  }
  return transfer;
}

async function transportDeltaJournal(
  tx: any,
  companyId: number,
  req: any,
  order: any,
  transfer: any,
  amount: number,
  direction: "to_wip" | "from_wip",
) {
  if (!order.issueJournalEntryId) return null;
  if (!order.wipAccountId) {
    throw Object.assign(new Error("حساب إنتاج تحت التشغيل مطلوب لإعادة تصنيف تكلفة النقل"), { status: 409 });
  }
  const expense = Number(transfer.internalTransportExpenseAccountId);
  const date = new Date().toISOString().slice(0, 10);
  return insertJournal(tx, companyId, req, {
    date,
    docNumber: order.orderNumber,
    branchId: order.branchId ?? null,
    entryType: direction === "to_wip"
      ? "internal_transport_reclassification"
      : "internal_transport_reclassification_reversal",
    description: `${direction === "to_wip" ? "تحميل" : "عكس تحميل"} تكلفة نقل داخلي ${transfer.transferNumber} لأمر ${order.orderNumber}`,
    lines: direction === "to_wip"
      ? [
          { accountId: Number(order.wipAccountId), debit: amount, description: "إنتاج تحت التشغيل — نقل داخلي" },
          { accountId: expense, credit: amount, description: "إعادة تصنيف مصروف نقل داخلي" },
        ]
      : [
          { accountId: expense, debit: amount, description: "عكس إعادة تصنيف مصروف نقل داخلي" },
          { accountId: Number(order.wipAccountId), credit: amount, description: "عكس إنتاج تحت التشغيل — نقل داخلي" },
        ],
  });
}

async function updateOrderTransportTotal(
  tx: any,
  companyId: number,
  order: any,
  delta: number,
) {
  const issued = !!order.issueJournalEntryId;
  await tx.update(productionOrdersTable).set({
    overheadCost: sql`greatest(0, ${productionOrdersTable.overheadCost} + ${delta.toFixed(2)}::numeric)`,
    ...(issued ? {
      actualCost: sql`greatest(0, ${productionOrdersTable.actualCost} + ${delta.toFixed(2)}::numeric)`,
    } : {}),
    updatedAt: new Date(),
  }).where(and(eq(productionOrdersTable.id, order.id), eq(productionOrdersTable.companyId, companyId)));
}

/**
 * Assign a posted transport cost to one open order.  The transfer source lock
 * serializes create/post/link/relink and the order rows are locked in numeric
 * order by the caller-visible transfer ownership.  The source expense is
 * deliberately posted before this function; linking never posts it again.
 */
export async function linkPostedInternalTransport(
  tx: any,
  companyId: number,
  transfer: any,
  productionOrderId: number | null,
  req: any,
  warehouseBranchIds: Array<number | null | undefined>,
) {
  if (transfer.status !== "posted") {
    throw Object.assign(new Error("يمكن ربط إذن التسليم بأمر الإنتاج بعد ترحيله فقط"), { status: 409 });
  }
  const amount = internalTransportAmount(transfer.internalTransportAmount);
  if (transfer.productionOrderId != null || productionOrderId != null) {
    assertInternalDeliveryOrderPermission(req, "post");
  }
  const targetPreview = productionOrderId == null ? null : await validateInternalTransportOrder(
    tx, companyId, productionOrderId, warehouseBranchIds, req,
  );
  // Lock order lifecycle keys first, in a stable order, then lock allocation
  // rows. This matches productionStatusHandler (order advisory → allocations)
  // and avoids a link/lifecycle deadlock.
  const linkedOrderId = transfer.productionOrderId == null ? null : Number(transfer.productionOrderId);
  const lockIds = [linkedOrderId, targetPreview?.id]
    .filter((id): id is number => Number.isInteger(id) && id > 0)
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort((a, b) => a - b);
  const locked = new Map<number, any>();
  for (const orderId of lockIds) locked.set(orderId, await lockOrder(tx, companyId, orderId, req));
  // Lifecycle takes the order lock before allocation rows and may release the
  // transfer association. Take this source key only after the same order
  // locks, so link/relink cannot form an order↔transfer deadlock with it.
  await lockTransportSource(tx, companyId, transfer.id);
  const allocations = await tx.select().from(productionCostAllocationsTable).where(and(
    eq(productionCostAllocationsTable.companyId, companyId),
    eq(productionCostAllocationsTable.sourceType, INTERNAL_TRANSPORT_SOURCE_TYPE),
    eq(productionCostAllocationsTable.sourceRecordId, transfer.id),
  )).for("update");
  const previous = allocations.find(activeTransportAllocation) ?? null;
  if (previous && previous.orderId !== linkedOrderId) {
    throw Object.assign(new Error("ملكية مصدر النقل الداخلي غير متسقة؛ لا يمكن إعادة ربطه تلقائياً"), { status: 409 });
  }
  if (previous && (previous.snapshotMeta as any)?.internalTransportActive === undefined &&
      productionOrderId !== linkedOrderId) {
    // Legacy overhead was maintained outside overheadCost. Do not guess a
    // historical WIP/base-cost normalization during unlink/relink. Exact
    // cancellation/reversal remains supported by the legacy journal evidence.
    throw Object.assign(new Error("إعادة ربط تكلفة نقل تاريخية تتطلب عكس الأمر الأصلي أولاً"), { status: 409 });
  }
  if (productionOrderId == null) {
    if (transfer.productionOrderId == null) {
      return { transfer, allocation: null, reclassificationJournalEntryId: null, idempotent: true };
    }
    const oldOrder = locked.get(linkedOrderId!)!;
    let reversalJournalEntryId: number | null = null;
    if (amount > 0 && previous) {
      reversalJournalEntryId = await transportDeltaJournal(
        tx, companyId, req, oldOrder, transfer, amount, "from_wip",
      );
      await updateOrderTransportTotal(tx, companyId, oldOrder, -amount);
      await tx.update(productionCostAllocationsTable).set({
        allocatedAmount: "0",
        snapshotMeta: {
          ...((previous.snapshotMeta as any) ?? {}),
          internalTransportActive: false,
          unlinkedAt: new Date().toISOString(),
          unlinkReclassificationJournalEntryId: reversalJournalEntryId,
          transportDeltaJournalEntryIds: appendTransportDelta(previous.snapshotMeta, reversalJournalEntryId),
        },
      }).where(eq(productionCostAllocationsTable.id, previous.id));
    }
    const [updatedTransfer] = await tx.update(stockTransfersTable).set({
      productionOrderId: null, updatedAt: new Date(),
    }).where(and(eq(stockTransfersTable.id, transfer.id), eq(stockTransfersTable.companyId, companyId))).returning();
    return {
      transfer: updatedTransfer, allocation: null,
      reclassificationJournalEntryId: reversalJournalEntryId, idempotent: false,
    };
  }
  if (amount === 0 && transfer.productionOrderId === productionOrderId) {
    return { transfer, allocation: null, reclassificationJournalEntryId: null, idempotent: true };
  }
  if (internalTransportLinkIsIdempotent(
    transfer.productionOrderId, previous?.orderId, productionOrderId,
  )) {
    return { transfer, allocation: previous, reclassificationJournalEntryId: null, idempotent: true };
  }
  const target = locked.get(targetPreview.id)!;
  // A zero-cost delivery remains operationally linkable while the feature is
  // disabled.  It has no source expense and therefore no cost allocation.
  if (amount === 0) {
    const [updatedTransfer] = await tx.update(stockTransfersTable).set({
      productionOrderId: target.id, updatedAt: new Date(),
    }).where(and(eq(stockTransfersTable.id, transfer.id), eq(stockTransfersTable.companyId, companyId))).returning();
    await recordInternalDeliveryLink(tx, companyId, target.id, transfer.id, req);
    return { transfer: updatedTransfer, allocation: null, reclassificationJournalEntryId: null, idempotent: false };
  }
  const sourceJournalId = await resolveLegacyInternalTransportSource(tx, companyId, transfer);
  let reversalJournalEntryId: number | null = null;
  if (previous) {
    const oldOrder = locked.get(previous.orderId)!;
    reversalJournalEntryId = await transportDeltaJournal(tx, companyId, req, oldOrder, transfer, amount, "from_wip");
    await updateOrderTransportTotal(tx, companyId, oldOrder, -amount);
    await tx.update(productionCostAllocationsTable).set({
      allocatedAmount: "0",
      snapshotMeta: {
        ...((previous.snapshotMeta as any) ?? {}),
        internalTransportActive: false,
        unlinkedAt: new Date().toISOString(),
        unlinkReclassificationJournalEntryId: reversalJournalEntryId,
        transportDeltaJournalEntryIds: appendTransportDelta(previous.snapshotMeta, reversalJournalEntryId),
      },
    }).where(eq(productionCostAllocationsTable.id, previous.id));
  }
  const meta = {
    label: `نقل داخلي للتحويل ${transfer.transferNumber}`,
    includeInManufacturing: true,
    costTreatment: "manufacturing_overhead",
    internalTransportActive: true,
    transportIncludedInOriginalIssue: !target.issueJournalEntryId,
    transportExpenseJournalEntryId: sourceJournalId,
    reclassificationAccounts: [{
      accountId: Number(transfer.internalTransportExpenseAccountId),
      weight: amount,
    }],
  };
  let allocation = allocations.find((row: any) => row.orderId === target.id) ?? null;
  const reclassificationJournalEntryId = await transportDeltaJournal(tx, companyId, req, target, transfer, amount, "to_wip");
  if (allocation) {
    const [updated] = await tx.update(productionCostAllocationsTable).set({
      allocatedAmount: amount.toFixed(2),
      sourceAmount: amount.toFixed(2),
      snapshotMeta: {
        ...((allocation.snapshotMeta as any) ?? {}),
        ...meta,
        // Once source evidence was included at the original issue, it stays
        // part of that immutable issue even after A→B→A relinking.
        transportIncludedInOriginalIssue: (allocation.snapshotMeta as any)?.transportIncludedInOriginalIssue === true ||
          !target.issueJournalEntryId,
        relinkedAt: new Date().toISOString(),
        reclassificationJournalEntryId,
        transportDeltaJournalEntryIds: appendTransportDelta(allocation.snapshotMeta, reclassificationJournalEntryId),
      },
    }).where(eq(productionCostAllocationsTable.id, allocation.id)).returning();
    allocation = updated;
  } else {
    const date = String(transfer.transferDate).slice(0, 10);
    [allocation] = await tx.insert(productionCostAllocationsTable).values({
      companyId,
      orderId: target.id,
      sourceType: INTERNAL_TRANSPORT_SOURCE_TYPE,
      sourceRecordId: transfer.id,
      periodStart: date,
      periodEnd: date,
      basis: "posted_internal_transport",
      sourceAmount: amount.toFixed(2),
      sharePct: "100",
      allocatedAmount: amount.toFixed(2),
      snapshotMeta: {
        ...meta,
        reclassificationJournalEntryId,
        transportDeltaJournalEntryIds: appendTransportDelta({}, reclassificationJournalEntryId),
      },
      createdBy: req.authUser?.id ?? null,
    }).returning();
  }
  await updateOrderTransportTotal(tx, companyId, target, amount);
  const [updatedTransfer] = await tx.update(stockTransfersTable).set({
    productionOrderId: target.id,
    updatedAt: new Date(),
  }).where(and(eq(stockTransfersTable.id, transfer.id), eq(stockTransfersTable.companyId, companyId))).returning();
  return { transfer: updatedTransfer, allocation, reclassificationJournalEntryId, idempotent: false };
}

/**
 * Called by the shared production lifecycle while cancelling/reversing an
 * issued order.  Initial issue allocations are already inverted by the
 * original issue journal; only late link/relink deltas have their own journal.
 */
export async function reverseLateInternalTransportDeltas(
  tx: any,
  companyId: number,
  order: any,
  req: any,
) {
  const rows = await tx.select().from(productionCostAllocationsTable).where(and(
    eq(productionCostAllocationsTable.companyId, companyId),
    eq(productionCostAllocationsTable.orderId, order.id),
    eq(productionCostAllocationsTable.sourceType, INTERNAL_TRANSPORT_SOURCE_TYPE),
  )).for("update");
  for (const row of rows) {
    const meta = (row.snapshotMeta as any) ?? {};
    // Reverse every standalone delta exactly once. This covers active late
    // links and the complete A→B→A history; the original production issue
    // remains responsible only for sources present at original issue time.
    const deltaIds = Array.isArray(meta.transportDeltaJournalEntryIds)
      ? meta.transportDeltaJournalEntryIds.map(Number).filter(Number.isInteger)
      : [];
    // Incoming historical allocations stored a single supplemental JE in a
    // column. Merge it into the same exact-line reversal engine, once only.
    const legacyDeltaId = Number(row.reclassificationJournalEntryId ?? 0);
    if (legacyDeltaId && !deltaIds.includes(legacyDeltaId)) deltaIds.push(legacyDeltaId);
    const reversed: Record<string, number> =
      meta.lifecycleReversalJournalEntryIds && typeof meta.lifecycleReversalJournalEntryIds === "object"
        ? { ...meta.lifecycleReversalJournalEntryIds } : {};
    if (legacyDeltaId && row.reversalJournalEntryId) {
      reversed[String(legacyDeltaId)] = Number(row.reversalJournalEntryId);
    }
    for (const deltaJournalId of deltaIds) {
      if (reversed[String(deltaJournalId)]) continue;
      const [original] = await tx.select({
        status: journalEntriesTable.status,
      }).from(journalEntriesTable).where(and(
        eq(journalEntriesTable.id, deltaJournalId),
        eq(journalEntriesTable.companyId, companyId),
      )).limit(1);
      const originalLines = original ? await tx.select({
        accountId: journalEntryLinesTable.accountId,
        debit: journalEntryLinesTable.debit,
        credit: journalEntryLinesTable.credit,
        description: journalEntryLinesTable.description,
        costCenter: journalEntryLinesTable.costCenter,
      }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, deltaJournalId)) : [];
      if (!original || originalLines.length < 2 || originalLines.some((line) => !line.accountId)) {
        throw Object.assign(new Error("لا يمكن عكس تسوية النقل الداخلي: القيد الأصلي غير مكتمل"), { status: 409 });
      }
      const journalId = await insertJournal(tx, companyId, req, {
        date: new Date().toISOString().slice(0, 10),
        docNumber: `${order.orderNumber}-TRN-REV`,
        branchId: order.branchId ?? null,
        entryType: "internal_transport_reclassification_reversal",
        status: original.status,
        description: `عكس تحميل تكلفة نقل داخلي لأمر ${order.orderNumber}`,
        lines: originalLines.map((line) => ({
          accountId: Number(line.accountId),
          debit: Number(line.credit),
          credit: Number(line.debit),
          description: `عكس: ${line.description ?? ""}`,
          costCenter: line.costCenter,
        })),
      });
      reversed[String(deltaJournalId)] = journalId;
    }
    await tx.update(productionCostAllocationsTable).set({
      ...(legacyDeltaId && reversed[String(legacyDeltaId)]
        ? { reversalJournalEntryId: reversed[String(legacyDeltaId)] } : {}),
      snapshotMeta: {
        ...meta,
        lifecycleReversalJournalEntryIds: reversed,
        lifecycleReversedAt: new Date().toISOString(),
      },
    }).where(eq(productionCostAllocationsTable.id, row.id));
  }
}

export async function releaseInternalTransportSourceOwnership(
  tx: any,
  companyId: number,
  orderId: number,
) {
  const rows = await tx.select().from(productionCostAllocationsTable).where(and(
    eq(productionCostAllocationsTable.companyId, companyId),
    eq(productionCostAllocationsTable.orderId, orderId),
    eq(productionCostAllocationsTable.sourceType, INTERNAL_TRANSPORT_SOURCE_TYPE),
  )).for("update");
  for (const row of rows) {
    await tx.update(productionCostAllocationsTable).set({
      allocatedAmount: "0",
      snapshotMeta: {
        ...((row.snapshotMeta as any) ?? {}),
        internalTransportActive: false,
        releasedAt: new Date().toISOString(),
      },
    }).where(eq(productionCostAllocationsTable.id, row.id));
  }
  await tx.update(stockTransfersTable).set({ productionOrderId: null, updatedAt: new Date() })
    .where(and(
      eq(stockTransfersTable.companyId, companyId),
      eq(stockTransfersTable.productionOrderId, orderId),
      eq(stockTransfersTable.transferType, "manufacturing"),
    ));
}

export async function recordInternalDeliveryLink(
  tx: any, companyId: number, orderId: number, transferId: number, req: any,
) {
  await tx.insert(productionEventsTable).values({
    companyId, orderId, eventType: "internal_delivery_linked",
    payload: { transferId }, userId: req.authUser?.id ?? null,
  });
}

// Historical links are evidence, not a second cost total. Current allocation
// amounts alone contribute to active cost; released documents remain visible.
export async function listInternalDeliveryEvidence(
  q: any, companyId: number, orderId: number, req: any,
) {
  const allocations = await q.select().from(productionCostAllocationsTable).where(and(
    eq(productionCostAllocationsTable.companyId, companyId),
    eq(productionCostAllocationsTable.orderId, orderId),
    eq(productionCostAllocationsTable.sourceType, INTERNAL_TRANSPORT_SOURCE_TYPE),
  ));
  const events = await q.select({ payload: productionEventsTable.payload }).from(productionEventsTable).where(and(
    eq(productionEventsTable.companyId, companyId),
    eq(productionEventsTable.orderId, orderId),
    eq(productionEventsTable.eventType, "internal_delivery_linked"),
  ));
  const historyIds = [...new Set([
    ...allocations.map((row: any) => Number(row.sourceRecordId)),
    ...events.map((row: any) => Number(row.payload?.transferId)),
  ].filter((id) => Number.isInteger(id) && id > 0))];
  const rows = await q.select().from(stockTransfersTable).where(and(
    eq(stockTransfersTable.companyId, companyId),
    eq(stockTransfersTable.transferType, "manufacturing"),
    or(eq(stockTransfersTable.productionOrderId, orderId),
      ...(historyIds.length ? [inArray(stockTransfersTable.id, historyIds)] : [])),
  )).orderBy(desc(stockTransfersTable.transferDate));
  const allowed = getAllowedBranchIds(req);
  let visible = rows;
  if (allowed !== null && rows.length) {
    const warehouseIds = [...new Set(rows.flatMap((row: any) => [row.fromWarehouseId, row.toWarehouseId]))];
    const warehouses = await q.select({ id: warehousesTable.id }).from(warehousesTable).where(and(
      eq(warehousesTable.companyId, companyId),
      inArray(warehousesTable.id, warehouseIds),
      inArray(warehousesTable.branchId, allowed),
    ));
    const permitted = new Set(warehouses.map((row: any) => row.id));
    visible = rows.filter((row: any) => permitted.has(row.fromWarehouseId) && permitted.has(row.toWarehouseId));
  }
  return visible.map((row: any) => {
    const allocation = allocations.find((entry: any) => entry.sourceRecordId === row.id);
    const isCurrentlyLinked = row.productionOrderId === orderId;
    const active = isCurrentlyLinked && !!allocation && activeTransportAllocation(allocation);
    return {
      id: row.id, transferNumber: row.transferNumber, transferDate: row.transferDate,
      status: row.status, internalTransportAmount: row.internalTransportAmount,
      internalTransportJournalEntryId: row.internalTransportJournalEntryId,
      currentProductionOrderId: row.productionOrderId, isCurrentlyLinked,
      associationState: isCurrentlyLinked ? "current" : "historical",
      allocatedAmount: active ? allocation.allocatedAmount : "0.00",
      active,
    };
  });
}