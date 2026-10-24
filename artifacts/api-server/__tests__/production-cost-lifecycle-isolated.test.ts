// Run only through scripts/run-isolated-production-cost-lifecycle.sh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountsTable,
  companiesTable,
  db,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  pool,
  productionCostAllocationsTable,
  productionDriverReconciliationsTable,
  productionEventsTable,
  productionOrderStagesTable,
  productionOrdersTable,
  productionStageResourceCostsTable,
  stockBalanceTable,
  usersTable,
  warehousesTable,
} from "@workspace/db";
import {
  postStageLinkedSourceCosts,
  productionStatusHandler,
} from "../src/routes/production.ts";

const armed = process.env.PRODUCTION_COST_LIFECYCLE === "1";

function response() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  };
}

test("isolated PostgreSQL stage-source finalization and reversal", { skip: !armed }, async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assert.match(databaseUrl, /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres\?sslmode=disable$/);
  const tag = `prod-cost-${randomUUID()}`;
  try {
    const [company] = await db.insert(companiesTable).values({
      nameAr: `اختبار ${tag}`, nameEn: tag, vatNumber: "300000000000003",
      crNumber: tag, city: "Riyadh", street: "Test", buildingNumber: "1", postalCode: "12345",
    }).returning();
    const [user] = await db.insert(usersTable).values({
      companyId: company.id, username: tag, passwordHash: "isolated-test-only",
      sessionToken: tag, role: "admin",
    }).returning();
    const [wip, rawInventory, finishedGoods, payrollExpense] = await Promise.all([
      db.insert(accountsTable).values({
        companyId: company.id, code: `${tag}-wip`, nameAr: "WIP", accountType: "asset",
      }).returning().then((rows) => rows[0]),
      db.insert(accountsTable).values({
        companyId: company.id, code: `${tag}-raw`, nameAr: "Raw inventory", accountType: "asset",
      }).returning().then((rows) => rows[0]),
      db.insert(accountsTable).values({
        companyId: company.id, code: `${tag}-fg`, nameAr: "Finished goods", accountType: "asset",
      }).returning().then((rows) => rows[0]),
      db.insert(accountsTable).values({
        companyId: company.id, code: `${tag}-payroll`, nameAr: "Payroll expense", accountType: "expense",
      }).returning().then((rows) => rows[0]),
    ]);
    const [warehouse] = await db.insert(warehousesTable).values({
      companyId: company.id, code: tag, nameAr: "Isolated production warehouse",
    }).returning();
    const [item] = await db.insert(itemsTable).values({
      companyId: company.id, code: tag, nameAr: "Isolated finished good", itemNature: "finished",
    }).returning();

    async function journal(entryType: string, description: string, debitAccountId: number,
      creditAccountId: number, amount: number) {
      const [entry] = await db.insert(journalEntriesTable).values({
        companyId: company.id, entryDate: "2026-10-24", description, entryType, status: "posted",
      }).returning();
      await db.insert(journalEntryLinesTable).values([
        { entryId: entry.id, accountId: debitAccountId, debit: String(amount), credit: "0", description, sortOrder: 0 },
        { entryId: entry.id, accountId: creditAccountId, debit: "0", credit: String(amount), description, sortOrder: 1 },
      ]);
      return entry;
    }

    const issue = await journal("production_issue", "Seed WIP material", wip.id, rawInventory.id, 50);
    const [order] = await db.insert(productionOrdersTable).values({
      companyId: company.id, orderNumber: tag, title: "Isolated source-cost order",
      status: "in_production", plannedQty: "1", producedQty: "0",
      resourceCostingVersion: 1, rawWarehouseId: warehouse.id,
      finishedWarehouseId: warehouse.id, productItemId: item.id,
      wipAccountId: wip.id, rawInventoryAccountId: rawInventory.id,
      finishedGoodsAccountId: finishedGoods.id, rawMaterialsCost: "50",
      actualCost: "50", issueJournalEntryId: issue.id, batchNumber: `${tag}-BATCH`,
      qrToken: `${tag}-TOKEN`,
    }).returning();
    const [stage] = await db.insert(productionOrderStagesTable).values({
      orderId: order.id, sequence: 1, code: "KNEAD", nameAr: "Kneading",
      status: "done", inputQty: "1", outputQty: "1", actualDurationMinutes: 120,
      workerCount: 1, resourceMode: "labor",
    }).returning();
    const [allocation] = await db.insert(productionCostAllocationsTable).values({
      companyId: company.id, orderId: order.id, sourceType: "payroll", sourceRecordId: 701,
      periodStart: "2026-10-01", periodEnd: "2026-10-31", basis: "operating_hours",
      sourceAmount: "100", sharePct: "50", allocatedAmount: "50", createdBy: user.id,
      snapshotMeta: {
        includeInManufacturing: true, formulaMethod: "operating_hours",
        formulaNumerator: 1, formulaDenominator: 2, industrialDriver: "labor_hours",
        reclassificationAccounts: [{ accountId: payrollExpense.id, weight: 1 }],
      },
    }).returning();
    const [stageCost] = await db.insert(productionStageResourceCostsTable).values({
      companyId: company.id, orderId: order.id, stageId: stage.id, component: "labor",
      sourceType: "payroll", sourceRecordId: 701, amount: "100", createdBy: user.id,
      snapshot: { sourceAllocationId: allocation.id, personHours: 2, hours: 2 },
    }).returning();
    const req: any = {
      authUser: { id: user.id, companyId: company.id, role: "admin", viewAllBranches: true, branchIds: [] },
      params: { id: String(order.id) },
      body: { status: "quality_check" },
      headers: {}, ip: "127.0.0.1", get: () => "isolated-test",
    };
    await db.insert(productionEventsTable).values({
      companyId: company.id, orderId: order.id, eventType: "stage_resource_sources_deferred",
      userId: user.id, payload: { sourceAllocationIds: [allocation.id], deferredAmount: 50 },
    });
    let linkedJournalId: number | null = null;
    await db.transaction(async (tx) => {
      const posted = await postStageLinkedSourceCosts(tx, company.id, order, stage, user.id, req);
      linkedJournalId = posted.journalEntryId;
      assert.equal(posted.amount, 100);
      assert.ok(posted.journalEntryId);
    });
    const stageLines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, Number(linkedJournalId)));
    assert.equal(stageLines.reduce((sum, line) => sum + Number(line.debit), 0), 100);
    assert.equal(stageLines.reduce((sum, line) => sum + Number(line.credit), 0), 100);
    const [orderAfterStagePosting] = await db.select().from(productionOrdersTable)
      .where(eq(productionOrdersTable.id, order.id));
    assert.equal(Number(orderAfterStagePosting.actualCost), 150);

    const qualityCheck = response();
    await productionStatusHandler(req, qualityCheck);
    assert.equal(qualityCheck.statusCode, 200, JSON.stringify(qualityCheck.body));
    req.body = { status: "completed", producedQty: 1, wasteQty: 0 };
    const completed = response();
    await productionStatusHandler(req, completed);
    assert.equal(completed.statusCode, 200, JSON.stringify(completed.body));
    const [completedOrder] = await db.select().from(productionOrdersTable)
      .where(eq(productionOrdersTable.id, order.id));
    assert.equal(completedOrder.status, "completed");
    assert.equal(Number(completedOrder.actualCost), 150);
    const [reconciliation] = await db.select().from(productionDriverReconciliationsTable)
      .where(and(
        eq(productionDriverReconciliationsTable.orderId, order.id),
        eq(productionDriverReconciliationsTable.baseAllocationId, allocation.id),
      ));
    assert.equal(Number(reconciliation.reconciledAmount), 100);
    assert.equal(Number(reconciliation.deltaAmount), 50);
    assert.equal(reconciliation.journalEntryId, null, "stage-posted source is not journaled again at receipt");
    const receiptLines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, completedOrder.receiptJournalEntryId!));
    assert.equal(receiptLines.reduce((sum, line) => sum + Number(line.debit), 0), 150);
    assert.equal(receiptLines.reduce((sum, line) => sum + Number(line.credit), 0), 150);

    req.body = { status: "reversed" };
    const reversed = response();
    await productionStatusHandler(req, reversed);
    assert.equal(reversed.statusCode, 200, JSON.stringify(reversed.body));
    const [reversedOrder] = await db.select().from(productionOrdersTable)
      .where(eq(productionOrdersTable.id, order.id));
    assert.equal(reversedOrder.status, "reversed");
    const reversalEvents = await db.select().from(productionEventsTable).where(and(
      eq(productionEventsTable.orderId, order.id),
      eq(productionEventsTable.eventType, "stage_resource_accrual_reversed"),
    ));
    assert.ok(reversalEvents.some((event: any) =>
      Number((event.payload as Record<string, unknown>).originalJournalEntryId) === linkedJournalId));
    const [balance] = await db.select().from(stockBalanceTable).where(and(
      eq(stockBalanceTable.companyId, company.id),
      eq(stockBalanceTable.itemId, item.id),
      eq(stockBalanceTable.warehouseId, warehouse.id),
    ));
    assert.equal(Number(balance?.qty ?? 0), 0);
  } finally {
    await pool.end();
  }
});
