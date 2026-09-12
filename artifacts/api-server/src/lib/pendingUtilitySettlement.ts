// Late utility invoices settle immutable pending-machine evidence.  This is
// intentionally separate from normal overhead-close calculation: the invoice
// debit already exists, and this module only moves that exact debit to WIP/FG.
import {
  journalEntriesTable,
  productionCostAllocationsTable,
  productionDriverReconciliationsTable,
  productionOverheadClosuresTable,
  productionOrdersTable,
  productionPendingUtilityClaimsTable,
  productionStageResourceCostsTable,
  purchaseInvoicesTable,
  stockBalanceTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getPostedIndustrialPurchaseCosts } from "./industrialPurchaseCosts.js";
import { settleProvisionalResourceCost, splitProvisionalResourceSettlement } from "./resourceCosting.js";
import { refreshItemCost } from "./stockHelpers.js";

const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
const qty = (value: unknown) => Number(value ?? 0);
const failure = (message: string, status = 409) =>
  Object.assign(new Error(message), { status });

export type PendingUtilitySource = {
  sourceType: "purchase_invoice";
  sourceRecordId: number;
  factoryId: number;
  costCenter: string;
};

type ProposalLine = {
  stageResourceCostId: number;
  orderId: number;
  kwh: number;
  allocatedAmount: number;
  provisionalAccrualAmount?: number;
  provisionalAccrualAccountId?: number;
};

type SettlementSnapshot = {
  utilityPendingSettlement: true;
  sourceType: "purchase_invoice";
  sourceRecordId: number;
  sourceDocumentId: number;
  sourceJournalId: number;
  sourceAccountId: number;
  factoryId: number;
  costCenter: string;
  period: string;
  availableAmount: number;
  allocations: ProposalLine[];
};

export function pendingUtilitySnapshot(value: unknown): SettlementSnapshot | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0] as Partial<SettlementSnapshot>;
  if (row?.utilityPendingSettlement !== true ||
      row.sourceType !== "purchase_invoice" ||
      !Number.isInteger(Number(row.sourceRecordId)) ||
      !Array.isArray(row.allocations)) return null;
  return row as SettlementSnapshot;
}

export function isPendingUtilityClosure(value: unknown): boolean {
  return pendingUtilitySnapshot(value) !== null;
}

/** Deterministic cent allocation shared by proposal creation and unit tests. */
export function allocatePendingUtilityAvailableAmount(
  availableAmount: number,
  stages: Array<Omit<ProposalLine, "allocatedAmount">>,
): ProposalLine[] {
  const available = money(availableAmount);
  const seen = new Set<number>();
  const sorted = [...stages].sort((a, b) => a.stageResourceCostId - b.stageResourceCostId);
  if (!(available > 0) || !Number.isFinite(available) || !sorted.length ||
      sorted.some((stage) => !Number.isInteger(stage.stageResourceCostId) ||
        stage.stageResourceCostId <= 0 || !Number.isInteger(stage.orderId) ||
        stage.orderId <= 0 || !(stage.kwh > 0) || !Number.isFinite(stage.kwh) ||
        (seen.has(stage.stageResourceCostId) ? true : (seen.add(stage.stageResourceCostId), false)))) {
    throw failure("أدلة مراحل الكهرباء المعلقة مكررة أو غير صالحة", 422);
  }
  const totalKwh = sorted.reduce((sum, stage) => sum + stage.kwh, 0);
  if (!(totalKwh > 0) || !Number.isFinite(totalKwh)) {
    throw failure("كيلوواط-ساعة أدلة الكهرباء المعلقة غير صالح", 422);
  }
  let assigned = 0;
  return sorted.map((stage, index) => {
    const allocatedAmount = index === sorted.length - 1
      ? money(available - assigned)
      : money(available * stage.kwh / totalKwh);
    assigned = money(assigned + allocatedAmount);
    return { ...stage, allocatedAmount };
  });
}

export function assertPendingUtilityClaimSnapshot(
  claims: Array<{ stageResourceCostId: number; sourceType: string; sourceRecordId: number; allocatedAmount: unknown }>,
  proposal: Pick<SettlementSnapshot, "sourceRecordId" | "allocations">,
) {
  if (claims.length !== proposal.allocations.length ||
      claims.some((claim) => claim.sourceType !== "purchase_invoice" ||
        claim.sourceRecordId !== proposal.sourceRecordId ||
        !proposal.allocations.some((line) => line.stageResourceCostId === claim.stageResourceCostId &&
          Math.abs(line.allocatedAmount - qty(claim.allocatedAmount)) < 0.005))) {
    throw failure("مطالبات تسوية الكهرباء لا تطابق اللقطة المجمدة", 409);
  }
}

export function assertPendingUtilityFinishedGoodsFacts(input: {
  orderNumber: string;
  productItemId?: number | null;
  finishedWarehouseId?: number | null;
  finishedGoodsAccountId?: number | null;
  batchNumber?: string | null;
  producedQty: unknown;
  receiptQty?: unknown;
  balanceQty?: unknown;
  hasDownstreamConsumption?: boolean;
}) {
  if (!input.productItemId || !input.finishedWarehouseId || !input.finishedGoodsAccountId ||
      !input.batchNumber || !(qty(input.producedQty) > 0) || input.receiptQty == null ||
      Math.abs(qty(input.receiptQty) - qty(input.producedQty)) > 0.0001) {
    throw failure(`لا يمكن تسوية الأمر المكتمل ${input.orderNumber}: حركة استلام البضاعة التامة الأصلية غير قابلة للإثبات`, 422);
  }
  if (input.hasDownstreamConsumption) {
    throw failure(`لا يمكن تسوية الأمر المكتمل ${input.orderNumber}: البضاعة التامة استُهلكت أو بيعت بعد الاستلام`, 422);
  }
  if (input.balanceQty == null || Math.abs(qty(input.balanceQty) - qty(input.producedQty)) > 0.0001) {
    throw failure(`لا يمكن تسوية الأمر المكتمل ${input.orderNumber}: لا يمكن عزل كامل تشغيلة البضاعة التامة في المخزون`, 422);
  }
}

export function pendingUtilityLifecycleAttempt(
  sourceKeyBase: string,
  attempts: Array<{ sourceKey: string; status: string }>,
) {
  const prefix = `${sourceKeyBase}:attempt:`;
  const numbered = attempts.map((row) => ({
    row,
    number: Number(String(row.sourceKey).slice(prefix.length)),
  })).filter(({ number }) => Number.isInteger(number) && number > 0)
    .sort((a, b) => b.number - a.number);
  const active = numbered.find(({ row }) => row.status !== "reversed")?.row;
  return active
    ? { sourceKey: active.sourceKey, reuseActive: true }
    : { sourceKey: `${prefix}${(numbered[0]?.number ?? 0) + 1}`, reuseActive: false };
}

export function pendingUtilityBlocksOrderTransition(target: string): boolean {
  return ["completed", "cancelled", "reversed"].includes(target);
}

export function assertPostedCompletedSettlementEntries(
  orderNumber: string,
  issue?: { entryType: string; status: string },
  receipt?: { entryType: string; status: string },
) {
  if (!issue || issue.entryType !== "production_issue" || issue.status !== "posted" ||
      !receipt || receipt.entryType !== "production_receipt" || receipt.status !== "posted") {
    throw failure(`لا يمكن تسوية الأمر المكتمل ${orderNumber}: يجب أن يكون قيدا الصرف والاستلام الأصليان مرحّلين`, 422);
  }
}

async function assertSourceNotInAnotherActiveClose(
  tx: any, companyId: number, sourceRecordId: number, ownClosureId?: number,
) {
  const rows = await tx.select({
    id: productionOverheadClosuresTable.id,
    status: productionOverheadClosuresTable.status,
    sourceSnapshot: productionOverheadClosuresTable.sourceSnapshot,
  }).from(productionOverheadClosuresTable).where(eq(
    productionOverheadClosuresTable.companyId, companyId,
  )).for("update");
  const conflict = rows.find((row: any) => row.id !== ownClosureId &&
    ["draft", "posted"].includes(String(row.status)) &&
    Array.isArray(row.sourceSnapshot) && row.sourceSnapshot.some((source: any) =>
      source?.sourceType === "purchase_invoice" &&
      Number(source?.sourceRecordId) === sourceRecordId,
    ));
  if (conflict) {
    throw failure(`فاتورة الكهرباء مجمّدة بالفعل في إغلاق مصروفات رقم ${conflict.id}`, 409);
  }
}

async function liveSource(
  tx: any,
  companyId: number,
  period: string,
  source: PendingUtilitySource,
) {
  const rows = await getPostedIndustrialPurchaseCosts(tx, companyId, {
    period,
    factoryId: source.factoryId,
    costCenter: source.costCenter,
    costType: "electricity",
  });
  const match = rows.find((row) =>
    row.sourceType === "purchase_invoice" &&
    Number(row.sourceLineId) === source.sourceRecordId &&
    row.allocationDriver === "machine_hours" &&
    qty(row.amount) > 0,
  );
  if (!match) {
    throw failure("فاتورة الكهرباء المحددة ليست مصدراً صناعياً مرحّلاً ومتوافقاً مع الفترة/المصنع/مركز التكلفة", 422);
  }
  const [invoice] = await tx.select({
    id: purchaseInvoicesTable.id,
    companyId: purchaseInvoicesTable.companyId,
    journalEntryId: purchaseInvoicesTable.journalEntryId,
    status: purchaseInvoicesTable.status,
  }).from(purchaseInvoicesTable).where(and(
    eq(purchaseInvoicesTable.id, match.sourceDocumentId),
    eq(purchaseInvoicesTable.companyId, companyId),
  )).limit(1);
  if (!invoice || invoice.status !== "posted" || !invoice.journalEntryId) {
    throw failure("فاتورة الكهرباء المصدر غير مرحّلة بقيد محاسبي صالح", 422);
  }
  const [journal] = await tx.select({
    id: journalEntriesTable.id,
    status: journalEntriesTable.status,
    entryType: journalEntriesTable.entryType,
  }).from(journalEntriesTable).where(and(
    eq(journalEntriesTable.id, invoice.journalEntryId),
    eq(journalEntriesTable.companyId, companyId),
  )).for("update").limit(1);
  if (!journal || journal.status !== "posted" || journal.entryType !== "purchase_invoice") {
    throw failure("قيد فاتورة الكهرباء المصدر غير مرحّل أو لا يتبع الفاتورة المحددة", 422);
  }
  return { source: match, sourceJournalId: journal.id };
}

async function sourceCapacityUsed(tx: any, companyId: number, sourceRecordId: number) {
  const [allocations, deltas, claims] = await Promise.all([
    tx.select({ amount: sql<string>`coalesce(sum(${productionCostAllocationsTable.allocatedAmount}), 0)` })
      .from(productionCostAllocationsTable)
      .innerJoin(productionOrdersTable, eq(productionOrdersTable.id, productionCostAllocationsTable.orderId))
      .where(and(
        eq(productionCostAllocationsTable.companyId, companyId),
        eq(productionCostAllocationsTable.sourceType, "purchase_invoice"),
        eq(productionCostAllocationsTable.sourceRecordId, sourceRecordId),
        sql`${productionOrdersTable.status} NOT IN ('cancelled', 'reversed')`,
      )),
    tx.select({ amount: sql<string>`coalesce(sum(${productionDriverReconciliationsTable.deltaAmount}), 0)` })
      .from(productionDriverReconciliationsTable)
      .innerJoin(productionOrdersTable, eq(productionOrdersTable.id, productionDriverReconciliationsTable.orderId))
      .where(and(
        eq(productionDriverReconciliationsTable.companyId, companyId),
        eq(productionDriverReconciliationsTable.sourceType, "purchase_invoice"),
        eq(productionDriverReconciliationsTable.sourceRecordId, sourceRecordId),
        isNull(productionDriverReconciliationsTable.reversalJournalEntryId),
        sql`${productionOrdersTable.status} NOT IN ('cancelled', 'reversed')`,
      )),
    tx.select({ amount: sql<string>`coalesce(sum(${productionPendingUtilityClaimsTable.allocatedAmount}), 0)` })
      .from(productionPendingUtilityClaimsTable)
      .where(and(
        eq(productionPendingUtilityClaimsTable.companyId, companyId),
        eq(productionPendingUtilityClaimsTable.sourceType, "purchase_invoice"),
        eq(productionPendingUtilityClaimsTable.sourceRecordId, sourceRecordId),
      )),
  ]);
  return money(qty(allocations[0]?.amount) + qty(deltas[0]?.amount) + qty(claims[0]?.amount));
}

export async function buildPendingUtilityProposal(
  tx: any,
  companyId: number,
  input: {
    period: string;
    branchId: number | null;
    pendingOrderIds: number[];
    utilitySource: PendingUtilitySource;
  },
): Promise<{ sourceSnapshot: SettlementSnapshot[]; actualAmount: number; lines: ProposalLine[] }> {
  const { period, branchId, pendingOrderIds, utilitySource } = input;
  if (utilitySource.sourceType !== "purchase_invoice" ||
      !Number.isInteger(utilitySource.sourceRecordId) || utilitySource.sourceRecordId <= 0 ||
      !Number.isInteger(utilitySource.factoryId) || utilitySource.factoryId <= 0 ||
      !utilitySource.costCenter?.trim()) {
    throw failure("مصدر فاتورة الكهرباء والمصنع ومركز التكلفة مطلوبة صراحةً", 400);
  }
  if (branchId == null || branchId !== utilitySource.factoryId) {
    throw failure("فرع إغلاق الكهرباء يجب أن يطابق المصنع المحدد صراحةً", 422);
  }
  const ids = [...new Set(pendingOrderIds)];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw failure("اختر أوامر الإنتاج المعلقة الصحيحة", 400);
  }
  await tx.execute(sql`select pg_advisory_xact_lock(
    ${companyId}, hashtext(${"purchase_invoice:" + utilitySource.sourceRecordId})
  )`);
  const live = await liveSource(tx, companyId, period, utilitySource);
  await assertSourceNotInAnotherActiveClose(tx, companyId, utilitySource.sourceRecordId);
  for (const id of [...ids].sort((a, b) => a - b)) {
    await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, ${id})`);
  }
  const orders = await tx.select().from(productionOrdersTable).where(and(
    eq(productionOrdersTable.companyId, companyId),
    inArray(productionOrdersTable.id, ids),
  )).for("update");
  if (orders.length !== ids.length ||
      orders.some((order: any) => order.branchId !== branchId || Number(order.resourceCostingVersion) !== 1)) {
    throw failure("يوجد أمر خارج الشركة/الفرع أو ليس أمر تكلفة موارد v1", 422);
  }
  const periodByOrder = new Map<number, string>(orders.map((order: any) => [
    order.id, String((order.meta as Record<string, unknown> | null)?.costPeriod ?? ""),
  ]));
  const evidence = await tx.select({
    id: productionStageResourceCostsTable.id,
    orderId: productionStageResourceCostsTable.orderId,
    sourceType: productionStageResourceCostsTable.sourceType,
    amount: productionStageResourceCostsTable.amount,
    snapshot: productionStageResourceCostsTable.snapshot,
  }).from(productionStageResourceCostsTable).where(and(
    eq(productionStageResourceCostsTable.companyId, companyId),
    eq(productionStageResourceCostsTable.component, "electricity"),
    eq(productionStageResourceCostsTable.sourceType, "pending_machine_electricity"),
    inArray(productionStageResourceCostsTable.orderId, ids),
  )).for("update");
  const byOrder = new Map<number, ProposalLine[]>();
  for (const row of evidence) {
    const snapshot = (row.snapshot ?? {}) as Record<string, unknown>;
    const kwh = qty(snapshot.kwh);
    if (snapshot.pendingUtilitySettlement !== true || periodByOrder.get(row.orderId) !== period || !(kwh > 0)) continue;
    const values = byOrder.get(row.orderId) ?? [];
    const provisionalAccrualAccountId = Number(snapshot.provisionalAccrualAccountId);
    const provisionalAccrualAmount = qty(snapshot.provisionalAccrualAmount ?? row.amount);
    values.push({
      stageResourceCostId: row.id, orderId: row.orderId, kwh, allocatedAmount: 0,
      ...(Number.isInteger(provisionalAccrualAccountId) && provisionalAccrualAccountId > 0 &&
          provisionalAccrualAmount > 0
        ? { provisionalAccrualAccountId, provisionalAccrualAmount }
        : {}),
    });
    byOrder.set(row.orderId, values);
  }
  if (ids.some((id) => !(byOrder.get(id)?.length))) {
    throw failure("كل أمر محدد يجب أن يحتوي أدلة كهرباء آلة معلقة ومجمدة ضمن الفترة المطلوبة", 422);
  }
  const existing = await tx.select({ stageResourceCostId: productionPendingUtilityClaimsTable.stageResourceCostId })
    .from(productionPendingUtilityClaimsTable).where(and(
      eq(productionPendingUtilityClaimsTable.companyId, companyId),
      inArray(productionPendingUtilityClaimsTable.stageResourceCostId, evidence.map((row: any) => row.id)),
    )).for("update");
  if (existing.length) throw failure("إحدى مراحل الكهرباء المعلقة محجوزة بالفعل في إغلاق آخر", 409);

  const used = await sourceCapacityUsed(tx, companyId, utilitySource.sourceRecordId);
  const available = money(qty(live.source.amount) - used);
  if (!(available > 0)) throw failure("لا يوجد رصيد متاح في فاتورة الكهرباء بعد التوزيعات/المطالبات السابقة", 409);
  const lines = allocatePendingUtilityAvailableAmount(available, [...byOrder.values()].flat());
  if (money(lines.reduce((sum, line) => sum + line.allocatedAmount, 0)) !== available) {
    throw failure("تعذر توزيع فاتورة الكهرباء بدقة على كيلوواط-ساعة المراحل المجمدة", 409);
  }
  return {
    actualAmount: available,
    lines,
    sourceSnapshot: [{
      utilityPendingSettlement: true,
      sourceType: "purchase_invoice",
      sourceRecordId: utilitySource.sourceRecordId,
      sourceDocumentId: live.source.sourceDocumentId,
      sourceJournalId: live.sourceJournalId,
      sourceAccountId: live.source.sourceAccountId,
      factoryId: utilitySource.factoryId,
      costCenter: utilitySource.costCenter.trim(),
      period,
      availableAmount: available,
      allocations: lines,
    }],
  };
}

type JournalLine = { accountId: number; debit?: number; credit?: number; description?: string; costCenter?: string | null };
type HelperDeps = {
  createJournalEntry: (options: any) => Promise<number>;
  lockStockBalances: (rows: Array<{ companyId: number; itemId: number; warehouseId: number }>, tx: any) => Promise<void>;
  getBalance: (companyId: number, itemId: number, warehouseId: number, tx: any) => Promise<number>;
  addStockLedgerEntry: (entry: any, tx: any) => Promise<void>;
};

async function assertCompletedFgOnHand(
  tx: any, companyId: number, order: any, amount: number, deps: HelperDeps, closureId?: number,
) {
  if (!order.productItemId || !order.finishedWarehouseId || !order.finishedGoodsAccountId || !order.batchNumber ||
      !(qty(order.producedQty) > 0)) {
    assertPendingUtilityFinishedGoodsFacts({
      orderNumber: order.orderNumber, productItemId: order.productItemId,
      finishedWarehouseId: order.finishedWarehouseId, finishedGoodsAccountId: order.finishedGoodsAccountId,
      batchNumber: order.batchNumber, producedQty: order.producedQty,
    });
  }
  await deps.lockStockBalances([{
    companyId, itemId: order.productItemId, warehouseId: order.finishedWarehouseId,
  }], tx);
  const receipt = await tx.execute(sql`
    select id, qty, total_cost
    from stock_ledger
    where company_id = ${companyId} and item_id = ${order.productItemId}
      and warehouse_id = ${order.finishedWarehouseId} and ref_id = ${order.id}
      and ref_type = 'production_order' and tx_type = 'production_receipt'
      and batch_number = ${order.batchNumber}
    order by id asc limit 1
  `);
  const receiptRow: any = receipt.rows?.[0];
  const downstream = await tx.execute(sql`
    select id from stock_ledger
    where company_id = ${companyId} and item_id = ${order.productItemId}
      and warehouse_id = ${order.finishedWarehouseId} and batch_number = ${order.batchNumber}
      and qty < 0 and id > ${Number(receiptRow.id)}
      and ref_type is distinct from 'production_order_reversal'
    order by id asc limit 1
  `);
  const [balance] = await tx.select().from(stockBalanceTable).where(and(
    eq(stockBalanceTable.companyId, companyId),
    eq(stockBalanceTable.itemId, order.productItemId),
    eq(stockBalanceTable.warehouseId, order.finishedWarehouseId),
  )).for("update");
  assertPendingUtilityFinishedGoodsFacts({
    orderNumber: order.orderNumber, productItemId: order.productItemId,
    finishedWarehouseId: order.finishedWarehouseId, finishedGoodsAccountId: order.finishedGoodsAccountId,
    batchNumber: order.batchNumber, producedQty: order.producedQty, receiptQty: receiptRow?.qty,
    balanceQty: balance?.qty, hasDownstreamConsumption: Boolean((downstream.rows ?? [])[0]),
  });
  if (closureId) {
    const adjustment = await tx.execute(sql`
      select id, total_cost from stock_ledger
      where company_id = ${companyId} and ref_id = ${closureId}
        and ref_type = 'production_pending_utility_settlement'
        and item_id = ${order.productItemId} and warehouse_id = ${order.finishedWarehouseId}
        and qty = 0 and total_cost = ${amount}
      order by id asc limit 1
    `);
    const adjustmentRow: any = adjustment.rows?.[0];
    if (!adjustmentRow) throw failure(`تعذر إثبات تعديل تكلفة مخزون الأمر ${order.orderNumber} لعكسه بأمان`);
    const later = await tx.execute(sql`
      select id from stock_ledger
      where company_id = ${companyId} and item_id = ${order.productItemId}
        and warehouse_id = ${order.finishedWarehouseId} and id > ${Number(adjustmentRow.id)}
      order by id asc limit 1
    `);
    if ((later.rows ?? [])[0]) {
      throw failure(`لا يمكن عكس تسوية الأمر ${order.orderNumber}: تغير مخزون البضاعة التامة بعد تعديل التكلفة`);
    }
  }
  return balance;
}

async function settlementClaims(tx: any, companyId: number, closureId: number) {
  return tx.select().from(productionPendingUtilityClaimsTable).where(and(
    eq(productionPendingUtilityClaimsTable.companyId, companyId),
    eq(productionPendingUtilityClaimsTable.closureId, closureId),
  )).for("update");
}

async function postedCompletedReceiptAllocation(tx: any, companyId: number, order: any) {
  if (!order.issueJournalEntryId || !order.receiptJournalEntryId) {
    throw failure(`لا يمكن تسوية الأمر المكتمل ${order.orderNumber}: قيد الصرف أو الاستلام الأصلي غير موجود`, 422);
  }
  const entries = await tx.select({
    id: journalEntriesTable.id,
    entryType: journalEntriesTable.entryType,
    status: journalEntriesTable.status,
  }).from(journalEntriesTable).where(and(
    eq(journalEntriesTable.companyId, companyId),
    inArray(journalEntriesTable.id, [order.issueJournalEntryId, order.receiptJournalEntryId]),
  )).for("update");
  const issue = entries.find((entry: any) => entry.id === order.issueJournalEntryId);
  const receipt = entries.find((entry: any) => entry.id === order.receiptJournalEntryId);
  assertPostedCompletedSettlementEntries(order.orderNumber, issue, receipt);
  const rows = await tx.execute(sql`
    select account_id as "accountId", debit
    from journal_entry_lines where entry_id = ${order.receiptJournalEntryId}
  `);
  const finishedGoods = (rows.rows ?? []).filter((line: any) =>
    Number(line.accountId) === Number(order.finishedGoodsAccountId))
    .reduce((sum: number, line: any) => sum + qty(line.debit), 0);
  const wasteAccountId = order.wasteAccountId ?? order.varianceAccountId;
  const abnormalWaste = wasteAccountId
    ? (rows.rows ?? []).filter((line: any) => Number(line.accountId) === Number(wasteAccountId))
      .reduce((sum: number, line: any) => sum + qty(line.debit), 0)
    : 0;
  if (!(finishedGoods > 0) || !(finishedGoods + abnormalWaste > 0)) {
    throw failure(`لا يمكن تسوية الأمر المكتمل ${order.orderNumber}: توزيع استلام البضاعة التامة/الهالك الأصلي غير قابل للإثبات`, 422);
  }
  return { finishedGoods, abnormalWaste, wasteAccountId };
}

export async function postPendingUtilitySettlement(
  tx: any, companyId: number, closure: any, req: any, deps: HelperDeps,
) {
  const snapshot = pendingUtilitySnapshot(closure.sourceSnapshot);
  if (!snapshot) throw failure("لقطة تسوية الكهرباء المعلقة غير صالحة");
  await tx.execute(sql`select pg_advisory_xact_lock(
    ${companyId}, hashtext(${"purchase_invoice:" + snapshot.sourceRecordId})
  )`);
  await assertSourceNotInAnotherActiveClose(tx, companyId, snapshot.sourceRecordId, closure.id);
  await liveSource(tx, companyId, snapshot.period, {
    sourceType: "purchase_invoice", sourceRecordId: snapshot.sourceRecordId,
    factoryId: snapshot.factoryId, costCenter: snapshot.costCenter,
  });
  const claims = await settlementClaims(tx, companyId, closure.id);
  assertPendingUtilityClaimSnapshot(claims, snapshot);
  const evidence = await tx.select({
    id: productionStageResourceCostsTable.id,
    amount: productionStageResourceCostsTable.amount,
    snapshot: productionStageResourceCostsTable.snapshot,
  }).from(productionStageResourceCostsTable).where(and(
    eq(productionStageResourceCostsTable.companyId, companyId),
    inArray(productionStageResourceCostsTable.id, snapshot.allocations.map((row) => row.stageResourceCostId)),
    eq(productionStageResourceCostsTable.component, "electricity"),
    eq(productionStageResourceCostsTable.sourceType, "pending_machine_electricity"),
  )).for("update");
  const evidenceById = new Map<number, any>(evidence.map((row: any) => [row.id, row]));
  if (evidence.length !== snapshot.allocations.length || snapshot.allocations.some((line) => {
    const frozen = evidenceById.get(line.stageResourceCostId);
    const values = (frozen?.snapshot ?? {}) as Record<string, unknown>;
    return values.pendingUtilitySettlement !== true ||
      !(qty(values.kwh) > 0) || Math.abs(qty(values.kwh) - line.kwh) > 0.0001;
  })) {
    throw failure("أدلة كيلوواط-ساعة الكهرباء لم تعد تطابق لقطة التسوية المجمدة", 409);
  }
  const used = await sourceCapacityUsed(tx, companyId, snapshot.sourceRecordId);
  const live = await getPostedIndustrialPurchaseCosts(tx, companyId, {
    period: snapshot.period, factoryId: snapshot.factoryId, costCenter: snapshot.costCenter, costType: "electricity",
  });
  const source = live.find((row) => row.sourceType === "purchase_invoice" &&
    Number(row.sourceLineId) === snapshot.sourceRecordId && row.allocationDriver === "machine_hours");
  if (!source || used > money(source.amount) + 0.005) {
    throw failure("تجاوزت مطالبات/توزيعات المصدر مبلغ فاتورة الكهرباء المرحّلة", 409);
  }
  const orderIds = [...new Set(snapshot.allocations.map((row) => row.orderId))].sort((a, b) => a - b);
  for (const id of orderIds) await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, ${id})`);
  const orders = await tx.select().from(productionOrdersTable).where(and(
    eq(productionOrdersTable.companyId, companyId), inArray(productionOrdersTable.id, orderIds),
  )).for("update");
  if (orders.length !== orderIds.length) throw failure("أحد أوامر التسوية لم يعد موجوداً");
  const amountByOrder = new Map<number, number>();
  const provisionalByOrder = new Map<number, { amount: number; accountId: number }>();
  for (const row of snapshot.allocations) {
    amountByOrder.set(row.orderId, money((amountByOrder.get(row.orderId) ?? 0) + row.allocatedAmount));
    const frozen = evidenceById.get(row.stageResourceCostId);
    const values = (frozen?.snapshot ?? {}) as Record<string, unknown>;
    const accountId = Number(values.provisionalAccrualAccountId);
    const accrued = qty(values.provisionalAccrualAmount ?? frozen?.amount);
    // Only new v1 provisional snapshots carry this account. Historical
    // evidence-only stages have no liability to clear and are not rewritten.
    if (Number.isInteger(accountId) && accountId > 0 && accrued > 0) {
      const current = provisionalByOrder.get(row.orderId);
      if (current && current.accountId !== accountId) {
        throw failure("استحقاقات كهرباء الأمر المؤقتة تستخدم حسابات امتصاص مختلفة", 422);
      }
      provisionalByOrder.set(row.orderId, {
        accountId, amount: money((current?.amount ?? 0) + accrued),
      });
    }
  }
  const lines: JournalLine[] = [];
  for (const order of orders) {
    const amount = amountByOrder.get(order.id) ?? 0;
    if (!(amount > 0) || order.branchId !== closure.branchId) throw failure("أمر التسوية أو فرعه لا يطابق لقطة الإغلاق", 422);
    const provisional = provisionalByOrder.get(order.id);
    const settlement = settleProvisionalResourceCost(amount,
      order.status === "completed" ? (provisional?.amount ?? 0) : 0);
    if (order.status === "completed") {
      const destination = await postedCompletedReceiptAllocation(tx, companyId, order);
      const split = splitProvisionalResourceSettlement(
        settlement.actualAmount, settlement.accruedAmount,
        destination.finishedGoods, destination.abnormalWaste,
      );
      const balance = await assertCompletedFgOnHand(tx, companyId, order, split.finishedGoodsDelta, deps);
      const newAvg = (qty(balance.avgCost) * qty(balance.qty) + split.finishedGoodsDelta) / qty(balance.qty);
      if (!(newAvg >= 0)) throw failure(`لا يمكن تسوية الأمر ${order.orderNumber}: تكلفة البضاعة التامة الناتجة غير صالحة`, 422);
      await tx.update(stockBalanceTable).set({ avgCost: String(newAvg.toFixed(4)), updatedAt: new Date() })
        .where(eq(stockBalanceTable.id, balance.id));
      await refreshItemCost(companyId, order.productItemId, tx);
      await deps.addStockLedgerEntry({
        companyId, itemId: order.productItemId, warehouseId: order.finishedWarehouseId,
        txDate: closure.correctionDate, txType: "production_receipt", qty: "0",
        costPrice: String(newAvg.toFixed(4)), totalCost: String(split.finishedGoodsDelta.toFixed(2)),
        balanceQty: String(balance.qty), refId: closure.id,
        refType: "production_pending_utility_settlement", batchNumber: order.batchNumber,
        notes: `تعديل تكلفة كهرباء معلقة لأمر ${order.orderNumber}`,
      }, tx);
      if (settlement.accruedAmount > 0) lines.push({
        accountId: provisional!.accountId, debit: settlement.accruedAmount,
        description: `إطفاء استحقاق كهرباء آلة مؤقت — ${order.orderNumber}`, costCenter: order.costCenter,
      });
      lines.push({
        accountId: order.finishedGoodsAccountId,
        debit: split.finishedGoodsDelta > 0 ? split.finishedGoodsDelta : 0,
        credit: split.finishedGoodsDelta < 0 ? Math.abs(split.finishedGoodsDelta) : 0,
        description: `فرق كهرباء فعلية معلقة — بضاعة تامة ${order.orderNumber}`, costCenter: order.costCenter,
      });
      if (Math.abs(split.abnormalWasteDelta) >= 0.005 && destination.wasteAccountId) lines.push({
        accountId: destination.wasteAccountId,
        debit: split.abnormalWasteDelta > 0 ? split.abnormalWasteDelta : 0,
        credit: split.abnormalWasteDelta < 0 ? Math.abs(split.abnormalWasteDelta) : 0,
        description: `فرق كهرباء فعلية معلقة — هالك غير طبيعي ${order.orderNumber}`, costCenter: order.costCenter,
      });
    } else {
      if (!["in_production", "paused", "quality_check"].includes(String(order.status)) ||
          !order.issueJournalEntryId || !order.wipAccountId) {
        throw failure(`لا يمكن تسوية الأمر ${order.orderNumber}: ليس نشطاً في WIP أو مكتمل المخزون قابل للإثبات`, 422);
      }
      lines.push({ accountId: order.wipAccountId, debit: settlement.actualAmount, description: `كهرباء فعلية معلقة — WIP ${order.orderNumber}`, costCenter: order.costCenter });
    }
    await tx.update(productionOrdersTable).set({
      actualCost: String(money(qty(order.actualCost) + (order.status === "completed" ? settlement.deltaAmount : settlement.actualAmount)).toFixed(2)), updatedAt: new Date(),
    }).where(and(eq(productionOrdersTable.id, order.id), eq(productionOrdersTable.companyId, companyId)));
  }
  const total = money([...amountByOrder.values()].reduce((sum, amount) => sum + amount, 0));
  if (Math.abs(total - snapshot.availableAmount) > 0.005 || !snapshot.sourceAccountId) {
    throw failure("إجمالي اقتراح الكهرباء لا يطابق المصدر المجمد", 409);
  }
  lines.push({ accountId: snapshot.sourceAccountId, credit: total, description: `إعادة تصنيف فاتورة كهرباء فعلية — ${snapshot.period}`, costCenter: snapshot.costCenter });
  const journalId = await deps.createJournalEntry({
    companyId, branchId: closure.branchId, date: closure.correctionDate,
    description: `تسوية فاتورة كهرباء معلقة (${snapshot.period})`,
    entryType: "production_pending_utility_settlement", status: "posted", audit: { req }, lines, dx: tx,
  });
  return { journalId, total, orderIds };
}

export async function reversePendingUtilitySettlement(
  tx: any, companyId: number, closure: any, reversalDate: string, req: any, deps: HelperDeps,
) {
  const snapshot = pendingUtilitySnapshot(closure.sourceSnapshot);
  if (!snapshot || !closure.journalEntryId) throw failure("لقطة/قيد تسوية الكهرباء المعلقة غير صالح");
  await tx.execute(sql`select pg_advisory_xact_lock(
    ${companyId}, hashtext(${"purchase_invoice:" + snapshot.sourceRecordId})
  )`);
  const claims = await settlementClaims(tx, companyId, closure.id);
  if (claims.length !== snapshot.allocations.length) throw failure("مطالبات التسوية غير مكتملة ولا يمكن عكسها بأمان");
  const [original] = await tx.select().from(journalEntriesTable).where(and(
    eq(journalEntriesTable.id, closure.journalEntryId), eq(journalEntriesTable.companyId, companyId),
  )).limit(1);
  if (!original || original.entryType !== "production_pending_utility_settlement" || original.status !== "posted") {
    throw failure("قيد تسوية الكهرباء الأصلي غير صالح");
  }
  const orderIds = [...new Set(snapshot.allocations.map((row) => row.orderId))].sort((a, b) => a - b);
  for (const id of orderIds) await tx.execute(sql`select pg_advisory_xact_lock(${companyId}, ${id})`);
  const orders = await tx.select().from(productionOrdersTable).where(and(
    eq(productionOrdersTable.companyId, companyId), inArray(productionOrdersTable.id, orderIds),
  )).for("update");
  const amounts = new Map<number, number>();
  const provisionalByOrder = new Map<number, number>();
  for (const row of snapshot.allocations) amounts.set(row.orderId, money((amounts.get(row.orderId) ?? 0) + row.allocatedAmount));
  for (const row of snapshot.allocations) {
    if (Number.isInteger(row.provisionalAccrualAccountId) && (row.provisionalAccrualAmount ?? 0) > 0) {
      provisionalByOrder.set(row.orderId, money((provisionalByOrder.get(row.orderId) ?? 0) + row.provisionalAccrualAmount!));
    }
  }
  for (const order of orders) {
    const amount = amounts.get(order.id) ?? 0;
    const settlement = settleProvisionalResourceCost(amount,
      order.status === "completed" ? (provisionalByOrder.get(order.id) ?? 0) : 0);
    if (order.status === "completed") {
      const destination = await postedCompletedReceiptAllocation(tx, companyId, order);
      const split = splitProvisionalResourceSettlement(
        settlement.actualAmount, settlement.accruedAmount,
        destination.finishedGoods, destination.abnormalWaste,
      );
      const balance = await assertCompletedFgOnHand(tx, companyId, order, split.finishedGoodsDelta, deps, closure.id);
      const newAvg = (qty(balance.avgCost) * qty(balance.qty) - split.finishedGoodsDelta) / qty(balance.qty);
      if (!(newAvg >= 0)) throw failure(`لا يمكن عكس تسوية الأمر ${order.orderNumber}: تكلفة المخزون الناتجة غير صالحة`);
      await tx.update(stockBalanceTable).set({ avgCost: String(newAvg.toFixed(4)), updatedAt: new Date() })
        .where(eq(stockBalanceTable.id, balance.id));
      await refreshItemCost(companyId, order.productItemId, tx);
      await deps.addStockLedgerEntry({
        companyId, itemId: order.productItemId, warehouseId: order.finishedWarehouseId,
        txDate: reversalDate, txType: "production_issue", qty: "0",
        costPrice: String(newAvg.toFixed(4)), totalCost: String((-split.finishedGoodsDelta).toFixed(2)),
        balanceQty: String(balance.qty), refId: closure.id,
        refType: "production_pending_utility_settlement_reversal", batchNumber: order.batchNumber,
        notes: `عكس تعديل تكلفة كهرباء معلقة لأمر ${order.orderNumber}`,
      }, tx);
    } else if (!["in_production", "paused", "quality_check"].includes(String(order.status))) {
      throw failure(`لا يمكن عكس تسوية الأمر ${order.orderNumber}: تغيرت وجهة WIP بعد الترحيل`);
    }
    const appliedAmount = order.status === "completed" ? settlement.deltaAmount : settlement.actualAmount;
    if (qty(order.actualCost) + 0.005 < appliedAmount) throw failure(`لا يمكن عكس تسوية الأمر ${order.orderNumber}: تكلفة الأمر الحالية لا تثبت مبلغ التسوية`);
    await tx.update(productionOrdersTable).set({
      actualCost: String(money(qty(order.actualCost) - appliedAmount).toFixed(2)), updatedAt: new Date(),
    }).where(and(eq(productionOrdersTable.id, order.id), eq(productionOrdersTable.companyId, companyId)));
  }
  const journalLines = await tx.execute(sql`
    select account_id as "accountId", debit, credit, description, cost_center as "costCenter"
    from journal_entry_lines where entry_id = ${original.id} order by sort_order asc
  `);
  const sourceLines: any[] = journalLines.rows ?? [];
  if (sourceLines.length < 2) throw failure("سطور قيد تسوية الكهرباء الأصلي غير مكتملة");
  const journalId = await deps.createJournalEntry({
    companyId, branchId: closure.branchId, date: reversalDate,
    description: `عكس تسوية فاتورة كهرباء معلقة — ${snapshot.period}`,
    entryType: "production_pending_utility_settlement_reversal", status: "posted", audit: { req },
    lines: sourceLines.map((line) => ({
      accountId: Number(line.accountId), debit: qty(line.credit), credit: qty(line.debit),
      description: `عكس: ${line.description ?? "تسوية كهرباء معلقة"}`, costCenter: line.costCenter ?? null,
    })), dx: tx,
  });
  await tx.delete(productionPendingUtilityClaimsTable).where(and(
    eq(productionPendingUtilityClaimsTable.companyId, companyId),
    eq(productionPendingUtilityClaimsTable.closureId, closure.id),
  ));
  return { journalId, orderIds };
}