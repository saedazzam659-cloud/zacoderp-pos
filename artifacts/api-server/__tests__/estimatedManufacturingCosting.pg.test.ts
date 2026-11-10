import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  accountsTable,
  companiesTable,
  db,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  pool,
  productionEstimatedCostAllocationsTable,
  productionEstimatedCostClosuresTable,
  productionEstimatedCostPoolsTable,
  productionEstimatedCostAllocationsTable,
  productionOrderItemsTable,
  productionOrderStagesTable,
  productionOrdersTable,
  stockBalanceTable,
  stockLedgerTable,
  usersTable,
  warehousesTable,
} from "@workspace/db";
import app from "../src/app.ts";
import { deleteCompanyWithRelations } from "../src/routes/admin.ts";

const tag = `tt_est_cost_${randomBytes(8).toString("hex")}`;
let server: http.Server | undefined;
let baseUrl = "";
let companyId = 0;
let userId = 0;
let token = "";

function previousMonthPeriod(now = new Date()): { period: string; start: string; end: string } {
  const priorMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = priorMonth.getUTCFullYear();
  const month = priorMonth.getUTCMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { period, start: `${period}-01`, end };
}

function periodMonthsAgo(offset: number, now = new Date()): { period: string; start: string; end: string } {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const period = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    period,
    start: `${period}-01`,
    end: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))
      .toISOString().slice(0, 10),
  };
}

function periodTimestamp(period: string, day: number): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

async function api(path: string, method: string, body?: Record<string, unknown>) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${baseUrl}${path}${separator}companyId=${companyId}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Record<string, any> : {},
  };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("estimated costing test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${tag} شركة اختبار`,
    nameEn: `${tag} disposable tenant`,
    vatNumber: "300000000000003",
    crNumber: tag,
    city: "Riyadh",
    street: "Test Street",
    buildingNumber: "1",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
    isInternalDemoWorkspace: false,
    viewAllBranches: true,
    autoPostingEnabled: true,
    autoPostProduction: true,
    menuPermissions: JSON.stringify({ simple_manufacturing: true }),
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  token = randomBytes(24).toString("hex");
  const [user] = await db.insert(usersTable).values({
    username: `${tag}_admin`,
    passwordHash: "unused-test-token",
    role: "admin",
    isActive: true,
    viewAllBranches: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  }).returning({ id: usersTable.id });
  userId = user.id;
});

after(async () => {
  try {
    if (companyId) {
      await db.update(companiesTable).set({ deletedAt: new Date() }).where(and(
        eq(companiesTable.id, companyId),
        eq(companiesTable.nameEn, `${tag} disposable tenant`),
        eq(companiesTable.isInternalDemoWorkspace, false),
      ));
      await deleteCompanyWithRelations(companyId, true);
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.end().catch(() => {});
  }
});

test("monthly estimated pool allocation creates and posts a balanced settlement without duplicating expense", {
  timeout: 90_000,
}, async () => {
  const { period, start, end } = previousMonthPeriod();
  const accounts = await db.insert(accountsTable).values([
    { companyId, code: `${tag}-wip`, nameAr: "WIP", accountType: "asset", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-raw`, nameAr: "Raw inventory", accountType: "asset", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-fg`, nameAr: "Finished goods", accountType: "asset", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-absorbed`, nameAr: "Absorbed overhead", accountType: "liability", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-expense`, nameAr: "Actual overhead expense", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-variance`, nameAr: "Cost variance", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-payable`, nameAr: "Payable", accountType: "liability", isActive: true, isPosting: true, level: 4 },
  ]).returning();
  const accountId = (suffix: string) => {
    const row = accounts.find((account) => account.code === `${tag}-${suffix}`);
    assert.ok(row, `missing ${suffix} test account`);
    return row.id;
  };
  const wipAccountId = accountId("wip");
  const rawInventoryAccountId = accountId("raw");
  const finishedGoodsAccountId = accountId("fg");
  const absorbedAccountId = accountId("absorbed");
  const actualExpenseAccountId = accountId("expense");
  const varianceAccountId = accountId("variance");
  const payableAccountId = accountId("payable");

  const [sourceExpense] = await db.insert(journalEntriesTable).values({
    companyId,
    entryDate: end,
    currency: "SAR",
    exchangeRate: "1",
    description: `${tag} already-posted monthly overhead`,
    entryType: "cash_expense",
    status: "posted",
  }).returning({ id: journalEntriesTable.id });
  await db.insert(journalEntryLinesTable).values([
    { entryId: sourceExpense.id, accountId: actualExpenseAccountId, debit: "110", credit: "0", description: "Posted overhead", sortOrder: 0 },
    { entryId: sourceExpense.id, accountId: payableAccountId, debit: "0", credit: "110", description: "Source payable", sortOrder: 1 },
  ]);

  const createdPool = await api("/api/simple-manufacturing/estimated-costing/pools", "POST", {
    period,
    code: `${tag}-OH`,
    nameAr: "مجمع تكاليف صناعية",
    estimatedAmount: 100,
    allocationBasis: "manual",
    monthlyDenominator: null,
    scopeType: "company",
    branchId: null,
    actualExpenseAccountId,
    absorbedAccountId,
    varianceAccountId,
  });
  assert.equal(createdPool.status, 201, JSON.stringify(createdPool.body));
  const poolId = Number(createdPool.body.pool?.id);
  assert.ok(poolId > 0, "pool creation must return its database id");

  const [warehouse] = await db.insert(warehousesTable).values({
    companyId,
    code: `${tag}-WH`,
    nameAr: "مخزن اختبار التصنيع",
  }).returning({ id: warehousesTable.id });
  const [rawItem] = await db.insert(itemsTable).values({
    companyId,
    code: `${tag}-RAW`,
    nameAr: "مادة خام اختبار",
    itemNature: "raw",
    costPrice: "10",
  }).returning({ id: itemsTable.id });
  await db.insert(stockBalanceTable).values({
    companyId,
    itemId: rawItem.id,
    warehouseId: warehouse.id,
    qty: "10",
    avgCost: "10",
  });
  const [order] = await db.insert(productionOrdersTable).values({
    companyId,
    orderNumber: `${tag}-ORDER`,
    title: "اختبار أمر تكلفة تقديرية",
    status: "draft",
    plannedQty: "1",
    producedQty: "0",
    manufacturingCostingMethod: "estimated",
    rawWarehouseId: warehouse.id,
    finishedWarehouseId: warehouse.id,
    wipAccountId,
    rawInventoryAccountId,
    finishedGoodsAccountId,
    overheadAccountId: absorbedAccountId,
    varianceAccountId,
    rawMaterialsCost: "10",
    laborCost: "0",
    overheadCost: "0",
    estimatedCost: "10",
    actualCost: "0",
    meta: { costPeriod: period },
    createdBy: userId,
  }).returning({ id: productionOrdersTable.id });
  await db.insert(productionOrderItemsTable).values({
    orderId: order.id,
    kind: "raw",
    itemId: rawItem.id,
    description: "مادة خام اختبار",
    quantity: "1",
    unitCode: "EA",
    unitCost: "10",
    totalCost: "10",
  });

  const savedAllocation = await api(
    `/api/simple-manufacturing/estimated-costing/orders/${order.id}/allocations`,
    "PUT",
    { allocations: [{ poolId, driverValue: 100 }] },
  );
  assert.equal(savedAllocation.status, 200, JSON.stringify(savedAllocation.body));
  assert.equal(Number(savedAllocation.body.allocations?.[0]?.allocatedAmount), 100);

  const approved = await api(`/api/simple-manufacturing/orders/${order.id}/status`, "POST", {
    status: "approved",
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const started = await api(`/api/simple-manufacturing/orders/${order.id}/status`, "POST", {
    status: "in_production",
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const [issuedOrder] = await db.select().from(productionOrdersTable)
    .where(eq(productionOrdersTable.id, order.id));
  assert.equal(issuedOrder.status, "in_production");
  assert.ok(issuedOrder.issueJournalEntryId, "starting production must post the issue entry");
  const frozenRows = await db.select().from(productionEstimatedCostAllocationsTable).where(and(
    eq(productionEstimatedCostAllocationsTable.companyId, companyId),
    eq(productionEstimatedCostAllocationsTable.orderId, order.id),
    eq(productionEstimatedCostAllocationsTable.poolId, poolId),
  ));
  assert.equal(frozenRows.length, 1, "issue must freeze the submitted pool allocation");

  const [issueJournal] = await db.select({
    id: journalEntriesTable.id,
    status: journalEntriesTable.status,
  }).from(journalEntriesTable).where(eq(journalEntriesTable.id, issuedOrder.issueJournalEntryId!));
  if (issueJournal.status !== "posted") {
    const postIssue = await api(`/api/journal-entries/${issueJournal.id}/post`, "POST");
    assert.equal(postIssue.status, 200, JSON.stringify(postIssue.body));
  }

  const enteredActual = await api(
    `/api/simple-manufacturing/estimated-costing/pools/${poolId}/actual`,
    "PUT",
    {
      actualAmount: 110,
      sourceReference: `JE-${sourceExpense.id}`,
      confirmAlreadyPosted: true,
    },
  );
  assert.equal(enteredActual.status, 200, JSON.stringify(enteredActual.body));
  const closureId = Number(enteredActual.body.closure?.id);
  assert.ok(closureId > 0, "complete posted allocations should produce a closure draft");
  assert.equal(enteredActual.body.closure.status, "draft");

  const listedClosures = await api(
    `/api/simple-manufacturing/estimated-costing/closures?period=${period}`,
    "GET",
  );
  assert.equal(listedClosures.status, 200, JSON.stringify(listedClosures.body));
  assert.ok(listedClosures.body.closures.some((row: any) =>
    Number(row.id) === closureId && row.status === "draft",
  ));

  const posted = await api(
    `/api/simple-manufacturing/estimated-costing/closures/${closureId}/post`,
    "POST",
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.closure.status, "posted");
  assert.equal(posted.body.idempotent, false);
  const [closure] = await db.select().from(productionEstimatedCostClosuresTable)
    .where(eq(productionEstimatedCostClosuresTable.id, closureId));
  assert.ok(closure.journalEntryId);
  const [closureJournal] = await db.select().from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, closure.journalEntryId!));
  assert.equal(closureJournal.status, "posted");
  assert.equal(closureJournal.entryType, "production_estimated_cost_closure");

  const settlementLines = await db.select({
    accountId: journalEntryLinesTable.accountId,
    debit: journalEntryLinesTable.debit,
    credit: journalEntryLinesTable.credit,
  }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, closure.journalEntryId!));
  assert.equal(
    settlementLines.reduce((sum, line) => sum + Number(line.debit), 0),
    settlementLines.reduce((sum, line) => sum + Number(line.credit), 0),
    "the posted settlement journal must balance",
  );
  const actualExpenseLines = settlementLines.filter((line) => line.accountId === actualExpenseAccountId);
  assert.equal(actualExpenseLines.reduce((sum, line) => sum + Number(line.debit), 0), 0);
  assert.equal(actualExpenseLines.reduce((sum, line) => sum + Number(line.credit), 0), 110);
  const sourceExpenseLines = await db.select({
    debit: journalEntryLinesTable.debit,
    credit: journalEntryLinesTable.credit,
  }).from(journalEntryLinesTable).where(and(
    eq(journalEntryLinesTable.entryId, sourceExpense.id),
    eq(journalEntryLinesTable.accountId, actualExpenseAccountId),
  ));
  assert.equal(sourceExpenseLines.length, 1, "settlement must not create another source expense debit");
  assert.equal(Number(sourceExpenseLines[0].debit), 110);

  const [closedPool] = await db.select({
    status: productionEstimatedCostPoolsTable.status,
  }).from(productionEstimatedCostPoolsTable).where(eq(productionEstimatedCostPoolsTable.id, poolId));
  assert.equal(closedPool.status, "closed");
});

test("hourly estimated pools reconcile completed, WIP, and cross-month orders from actual stage drivers", {
  timeout: 120_000,
}, async () => {
  // Keep both periods clear of the neighboring test's intentionally posted
  // previous-month closure so the same tenant can exercise multiple periods.
  const firstPeriod = periodMonthsAgo(4);
  const secondPeriod = periodMonthsAgo(3);
  const localTag = `${tag}_hourly`;
  const accounts = await db.insert(accountsTable).values([
    { companyId, code: `${localTag}-wip`, nameAr: "WIP", accountType: "asset", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${localTag}-raw`, nameAr: "Raw inventory", accountType: "asset", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${localTag}-fg`, nameAr: "Finished goods", accountType: "asset", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${localTag}-absorbed`, nameAr: "Absorbed overhead", accountType: "liability", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${localTag}-expense`, nameAr: "Actual overhead expense", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${localTag}-variance`, nameAr: "Cost variance", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${localTag}-payable`, nameAr: "Payable", accountType: "liability", isActive: true, isPosting: true, level: 4 },
  ]).returning();
  const accountId = (suffix: string) => {
    const row = accounts.find((account) => account.code === `${localTag}-${suffix}`);
    assert.ok(row, `missing ${suffix} test account`);
    return row.id;
  };
  const wipAccountId = accountId("wip");
  const rawAccountId = accountId("raw");
  const finishedAccountId = accountId("fg");
  const absorbedAccountId = accountId("absorbed");
  const expenseAccountId = accountId("expense");
  const varianceAccountId = accountId("variance");
  const payableAccountId = accountId("payable");

  const [warehouse] = await db.insert(warehousesTable).values({
    companyId,
    code: `${localTag}-WH`,
    nameAr: "مخزن اختبار محركات الساعة",
  }).returning({ id: warehousesTable.id });
  const products = await db.insert(itemsTable).values(["A", "B", "C"].map((name) => ({
    companyId,
    code: `${localTag}-${name}`,
    nameAr: `${localTag} منتج ${name}`,
    itemNature: "finished",
    costPrice: "10",
  }))).returning({ id: itemsTable.id, code: itemsTable.code });
  const productByCode = new Map(products.map((item) => [item.code, item.id]));

  const postJournal = async (
    description: string,
    entryType: string,
    debitAccountId: number,
    creditAccountId: number,
    amount: number,
  ) => {
    const [entry] = await db.insert(journalEntriesTable).values({
      companyId,
      entryDate: firstPeriod.end,
      currency: "SAR",
      exchangeRate: "1",
      description,
      entryType,
      status: "posted",
    }).returning({ id: journalEntriesTable.id });
    await db.insert(journalEntryLinesTable).values([
      { entryId: entry.id, accountId: debitAccountId, debit: String(amount), credit: "0", description, sortOrder: 0 },
      { entryId: entry.id, accountId: creditAccountId, debit: "0", credit: String(amount), description, sortOrder: 1 },
    ]);
    return entry.id;
  };
  const makeOrder = async (
    name: string,
    productCode: string,
    status: string,
    plannedStart: string,
    initialOverhead: number,
  ) => {
    const itemId = productByCode.get(`${localTag}-${productCode}`);
    assert.ok(itemId, `missing product ${productCode}`);
    const batchNumber = `${localTag}-${name}-BATCH`;
    const issueJournalEntryId = await postJournal(
      `${localTag} issue ${name}`, "production_issue", wipAccountId, absorbedAccountId, initialOverhead,
    );
    const [order] = await db.insert(productionOrdersTable).values({
      companyId,
      orderNumber: `${localTag}-${name}`,
      title: `${localTag} ${name}`,
      status,
      plannedQty: "1",
      producedQty: status === "completed" ? "1" : "0",
      productItemId: itemId,
      rawWarehouseId: warehouse.id,
      finishedWarehouseId: warehouse.id,
      wipAccountId,
      rawInventoryAccountId: rawAccountId,
      finishedGoodsAccountId: finishedAccountId,
      overheadAccountId: absorbedAccountId,
      varianceAccountId,
      issueJournalEntryId,
      batchNumber,
      manufacturingCostingMethod: "estimated",
      rawMaterialsCost: "0",
      laborCost: "0",
      overheadCost: "0",
      estimatedCost: "0",
      actualCost: "100",
      meta: { costPeriod: plannedStart },
      createdBy: userId,
      ...(status === "completed" ? { actualEndAt: periodTimestamp(firstPeriod.period, 20) } : {}),
    }).returning();
    let receiptJournalEntryId: number | null = null;
    if (status === "completed") {
      receiptJournalEntryId = await postJournal(
        `${localTag} receipt ${name}`, "production_receipt", finishedAccountId, wipAccountId, 1,
      );
      await db.update(productionOrdersTable).set({ receiptJournalEntryId })
        .where(eq(productionOrdersTable.id, order.id));
      await db.insert(stockBalanceTable).values({
        companyId, itemId, warehouseId: warehouse.id, qty: "1", avgCost: "10",
      });
      await db.insert(stockLedgerTable).values({
        companyId,
        itemId,
        warehouseId: warehouse.id,
        txDate: firstPeriod.end,
        txType: "production_receipt",
        qty: "1",
        costPrice: "10",
        totalCost: "10",
        balanceQty: "1",
        refId: order.id,
        refType: "production_order",
        batchNumber,
        notes: `${localTag} finished batch`,
      });
    }
    return { order, itemId, batchNumber, issueJournalEntryId, receiptJournalEntryId };
  };

  const poolOneResponse = await api("/api/simple-manufacturing/estimated-costing/pools", "POST", {
    period: firstPeriod.period,
    code: `${localTag}-MACHINE-1`,
    nameAr: "تحميل ساعات الآلات الشهر الأول",
    estimatedAmount: 1300,
    allocationBasis: "machine_hours",
    monthlyDenominator: 13,
    scopeType: "company",
    branchId: null,
    actualExpenseAccountId: expenseAccountId,
    absorbedAccountId,
    varianceAccountId,
  });
  assert.equal(poolOneResponse.status, 201, JSON.stringify(poolOneResponse.body));
  const poolOneId = Number(poolOneResponse.body.pool?.id);

  const completed = await makeOrder("COMPLETED", "A", "completed", firstPeriod.period, 400);
  const wip = await makeOrder("WIP", "B", "in_production", firstPeriod.period, 600);
  const spanning = await makeOrder("SPANNING", "C", "in_production", firstPeriod.period, 300);
  const poolOneAllocations = [
    { order: completed.order, plannedHours: 4, amount: 400 },
    { order: wip.order, plannedHours: 6, amount: 600 },
    { order: spanning.order, plannedHours: 3, amount: 300 },
  ];
  await db.insert(productionEstimatedCostAllocationsTable).values(poolOneAllocations.map((row) => ({
    companyId,
    poolId: poolOneId,
    orderId: row.order.id,
    basis: "machine_hours",
    driverValue: String(row.plannedHours),
    denominatorSnapshot: "13",
    sharePct: String(row.plannedHours / 13 * 100),
    allocatedAmount: String(row.amount),
    poolAmountSnapshot: "1300",
    periodStart: firstPeriod.start,
    periodEnd: firstPeriod.end,
    snapshotMeta: {
      code: `${localTag}-MACHINE-1`,
      branchId: null,
      actualExpenseAccountId: expenseAccountId,
      absorbedAccountId,
      varianceAccountId,
    },
    createdBy: userId,
  })));

  await db.insert(productionOrderStagesTable).values([
    {
      orderId: completed.order.id, sequence: 1, code: "RUN-A", nameAr: "تشغيل A",
      status: "done", resourceMode: "machine", expectedDurationMinutes: 240,
      actualDurationMinutes: 300, completedAt: periodTimestamp(firstPeriod.period, 10),
    },
    {
      orderId: wip.order.id, sequence: 1, code: "RUN-B", nameAr: "تشغيل B",
      status: "done", resourceMode: "machine", expectedDurationMinutes: 360,
      actualDurationMinutes: 180, completedAt: periodTimestamp(firstPeriod.period, 12),
    },
    {
      orderId: spanning.order.id, sequence: 1, code: "RUN-C1", nameAr: "تشغيل C - مرحلة أولى",
      status: "done", resourceMode: "machine", expectedDurationMinutes: 180,
      actualDurationMinutes: 180, completedAt: periodTimestamp(firstPeriod.period, 15),
    },
    {
      orderId: spanning.order.id, sequence: 2, code: "RUN-C2", nameAr: "تشغيل C - مرحلة ثانية",
      status: "pending", resourceMode: "machine", expectedDurationMinutes: 120,
      actualDurationMinutes: 0,
    },
  ]);

  const poolTwoResponse = await api("/api/simple-manufacturing/estimated-costing/pools", "POST", {
    period: secondPeriod.period,
    code: `${localTag}-MACHINE-2`,
    nameAr: "تحميل ساعات الآلات الشهر الثاني",
    estimatedAmount: 500,
    allocationBasis: "machine_hours",
    monthlyDenominator: 5,
    scopeType: "company",
    branchId: null,
    actualExpenseAccountId: expenseAccountId,
    absorbedAccountId,
    varianceAccountId,
  });
  assert.equal(poolTwoResponse.status, 201, JSON.stringify(poolTwoResponse.body));
  const poolTwoId = Number(poolTwoResponse.body.pool?.id);

  const firstSourceId = await postJournal(
    `${localTag} actual machine overhead month one`,
    "cash_expense", expenseAccountId, payableAccountId, 1650,
  );
  const firstActual = await api(
    `/api/simple-manufacturing/estimated-costing/pools/${poolOneId}/actual`,
    "PUT",
    { actualAmount: 1650, sourceReference: `JE-${firstSourceId}`, confirmAlreadyPosted: true },
  );
  assert.equal(firstActual.status, 200, JSON.stringify(firstActual.body));
  const firstClosureId = Number(firstActual.body.closure?.id);
  assert.ok(firstClosureId > 0, "first month should produce a closure draft");
  assert.equal(Number(firstActual.body.closure.appliedAmount), 1100);
  assert.equal(Number(firstActual.body.closure.varianceAmount), 550);
  const firstSnapshot = firstActual.body.closure.sourceSnapshot?.[0]?.pools?.find(
    (row: any) => Number(row.poolId) === poolOneId,
  );
  assert.equal(Number(firstSnapshot.actualDriverTotal), 11);
  assert.equal(Number(firstSnapshot.plannedDriverTotal), 13);
  assert.equal(Number(firstSnapshot.usageVarianceDriver), -2);
  assert.deepEqual(
    firstSnapshot.driverOrders.map((row: any) => [row.orderNumber, row.plannedDriverValue, row.actualDriverValue]),
    [
      [`${localTag}-COMPLETED`, 4, 5],
      [`${localTag}-WIP`, 6, 3],
      [`${localTag}-SPANNING`, 3, 3],
    ],
  );

  const firstPosted = await api(
    `/api/simple-manufacturing/estimated-costing/closures/${firstClosureId}/post`,
    "POST",
  );
  assert.equal(firstPosted.status, 200, JSON.stringify(firstPosted.body));
  const [firstClosure] = await db.select().from(productionEstimatedCostClosuresTable)
    .where(eq(productionEstimatedCostClosuresTable.id, firstClosureId));
  const firstLines = await db.select({
    accountId: journalEntryLinesTable.accountId,
    debit: journalEntryLinesTable.debit,
    credit: journalEntryLinesTable.credit,
    description: journalEntryLinesTable.description,
  }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, firstClosure.journalEntryId!));
  assert.equal(
    firstLines.reduce((sum, line) => sum + Number(line.debit), 0),
    firstLines.reduce((sum, line) => sum + Number(line.credit), 0),
  );
  assert.equal(firstLines.filter((line) => line.accountId === finishedAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 350);
  assert.equal(firstLines.filter((line) => line.accountId === wipAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 0);
  assert.equal(firstLines.filter((line) => line.accountId === absorbedAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 1300);
  assert.equal(firstLines.filter((line) => line.accountId === expenseAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), -1650);
  assert.equal(firstLines.some((line) =>
    line.accountId === wipAccountId && line.description?.includes(`${localTag}-WIP`) &&
      Number(line.credit) - Number(line.debit) === 150,
  ), true, "the WIP order's negative correction must reduce its prior estimate");
  assert.equal(firstLines.some((line) =>
    line.accountId === wipAccountId && line.description?.includes(`${localTag}-SPANNING`) &&
      Number(line.debit) - Number(line.credit) === 150,
  ), true, "the cross-month order keeps its first-month actual cost in WIP");
  const sourceLines = await db.select().from(journalEntryLinesTable).where(and(
    eq(journalEntryLinesTable.entryId, firstSourceId),
    eq(journalEntryLinesTable.accountId, expenseAccountId),
  ));
  assert.equal(sourceLines.length, 1);
  assert.equal(Number(sourceLines[0].debit), 1650, "the actual source expense must not be posted again");

  const stageTwo = await db.select().from(productionOrderStagesTable).where(and(
    eq(productionOrderStagesTable.orderId, spanning.order.id),
    eq(productionOrderStagesTable.sequence, 2),
  ));
  assert.equal(stageTwo.length, 1);
  await db.update(productionOrderStagesTable).set({
    status: "done",
    actualDurationMinutes: 180,
    completedAt: periodTimestamp(secondPeriod.period, 8),
  }).where(eq(productionOrderStagesTable.id, stageTwo[0].id));

  const receiptForSpanning = await postJournal(
    `${localTag} receipt spanning order`,
    "production_receipt", finishedAccountId, wipAccountId, 1,
  );
  await db.update(productionOrdersTable).set({
    status: "completed",
    producedQty: "1",
    receiptJournalEntryId: receiptForSpanning,
    actualEndAt: periodTimestamp(secondPeriod.period, 10),
  }).where(eq(productionOrdersTable.id, spanning.order.id));
  await db.insert(stockBalanceTable).values({
    companyId,
    itemId: spanning.itemId,
    warehouseId: warehouse.id,
    qty: "1",
    avgCost: "10",
  });
  await db.insert(stockLedgerTable).values({
    companyId,
    itemId: spanning.itemId,
    warehouseId: warehouse.id,
    txDate: secondPeriod.end,
    txType: "production_receipt",
    qty: "1",
    costPrice: "10",
    totalCost: "10",
    balanceQty: "1",
    refId: spanning.order.id,
    refType: "production_order",
    batchNumber: spanning.batchNumber,
    notes: `${localTag} second-month finished batch`,
  });

  const secondSourceId = await postJournal(
    `${localTag} actual machine overhead month two`,
    "cash_expense", expenseAccountId, payableAccountId, 350,
  );
  const secondActual = await api(
    `/api/simple-manufacturing/estimated-costing/pools/${poolTwoId}/actual`,
    "PUT",
    { actualAmount: 350, sourceReference: `JE-${secondSourceId}`, confirmAlreadyPosted: true },
  );
  assert.equal(secondActual.status, 200, JSON.stringify(secondActual.body));
  const secondClosureId = Number(secondActual.body.closure?.id);
  assert.ok(secondClosureId > 0, "second month should close without a pre-start allocation row");
  assert.equal(Number(secondActual.body.closure.appliedAmount), 300);
  assert.equal(Number(secondActual.body.closure.varianceAmount), 50);
  const secondSnapshot = secondActual.body.closure.sourceSnapshot?.[0]?.pools?.find(
    (row: any) => Number(row.poolId) === poolTwoId,
  );
  assert.equal(Number(secondSnapshot.actualDriverTotal), 3);
  assert.equal(Number(secondSnapshot.plannedDriverTotal), 2);
  assert.equal(Number(secondSnapshot.usageVarianceDriver), 1);
  assert.equal(secondSnapshot.driverOrders.length, 1);
  assert.equal(secondSnapshot.driverOrders[0].orderNumber, `${localTag}-SPANNING`);
  assert.equal(secondSnapshot.driverOrders[0].initialEstimatedAmount, 0);

  const secondPosted = await api(
    `/api/simple-manufacturing/estimated-costing/closures/${secondClosureId}/post`,
    "POST",
  );
  assert.equal(secondPosted.status, 200, JSON.stringify(secondPosted.body));
  const [secondClosure] = await db.select().from(productionEstimatedCostClosuresTable)
    .where(eq(productionEstimatedCostClosuresTable.id, secondClosureId));
  const secondLines = await db.select({
    accountId: journalEntryLinesTable.accountId,
    debit: journalEntryLinesTable.debit,
    credit: journalEntryLinesTable.credit,
  }).from(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, secondClosure.journalEntryId!));
  assert.equal(
    secondLines.reduce((sum, line) => sum + Number(line.debit), 0),
    secondLines.reduce((sum, line) => sum + Number(line.credit), 0),
  );
  assert.equal(secondLines.filter((line) => line.accountId === finishedAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 350);
  assert.equal(secondLines.filter((line) => line.accountId === absorbedAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), 0);
  assert.equal(secondLines.filter((line) => line.accountId === expenseAccountId)
    .reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0), -350);
});
