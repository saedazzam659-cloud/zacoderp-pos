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
  productionOrderItemsTable,
  productionOrdersTable,
  stockBalanceTable,
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
