import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  branchesTable,
  companiesTable,
  db,
  pool,
  posOrderItemsTable,
  posOrdersTable,
  posTablesTable,
  salesInvoicesTable,
  usersTable,
} from "@workspace/db";
import app from "../src/app.ts";

const TEST_TAG = `tt_restaurant_cancel_${randomBytes(8).toString("hex")}`;
let server: http.Server | undefined;
let baseUrl = "";
let companyId = 0;
let branchId = 0;
let tableId = 0;
let orderId = 0;
let servedLineId = 0;
let pendingLineId = 0;
let token = "";

async function api(path: string, method: string, body?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}?companyId=${companyId}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseBody = await response.json() as Record<string, any>;
  return { status: response.status, body: responseBody };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${TEST_TAG} شركة اختبار`,
    nameEn: `${TEST_TAG} restaurant cancellation test`,
    vatNumber: "300000000000003",
    crNumber: "1010000001",
    city: "Riyadh",
    street: "Test Street",
    buildingNumber: "1",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
    isInternalDemoWorkspace: false,
    menuPermissions: JSON.stringify({ pos_waiter: true, pos_kitchen: true }),
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  const [branch] = await db.insert(branchesTable).values({
    companyId,
    code: `${TEST_TAG}-BR`,
    nameAr: "فرع اختبار",
    nameEn: "Test branch",
  }).returning({ id: branchesTable.id });
  branchId = branch.id;

  token = `${TEST_TAG}_${randomBytes(16).toString("hex")}`;
  await db.insert(usersTable).values({
    username: `${TEST_TAG}_admin`,
    passwordHash: "unused-test-token",
    role: "admin",
    isActive: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  });

  const [table] = await db.insert(posTablesTable).values({
    companyId, branchId, code: `${TEST_TAG}-T1`, nameAr: "طاولة اختبار",
    capacity: 4, status: "occupied",
  }).returning({ id: posTablesTable.id });
  tableId = table.id;

  const [order] = await db.insert(posOrdersTable).values({
    companyId, branchId, orderNumber: `${TEST_TAG}-ORDER`,
    channel: "dine_in", tableId, status: "open",
  }).returning({ id: posOrdersTable.id });
  orderId = order.id;
  await db.update(posTablesTable).set({ currentOrderId: orderId })
    .where(eq(posTablesTable.id, tableId));

  const lines = await db.insert(posOrderItemsTable).values([
    { orderId, menuItemId: 1, nameSnapshot: "صنف تم تقديمه" },
    { orderId, menuItemId: 2, nameSnapshot: "صنف قيد التحضير" },
  ]).returning({ id: posOrderItemsTable.id });
  servedLineId = lines[0].id;
  pendingLineId = lines[1].id;
});

after(async () => {
  try {
    if (companyId) {
      await db.delete(posOrderItemsTable).where(eq(posOrderItemsTable.orderId, orderId));
      await db.delete(posOrdersTable).where(eq(posOrdersTable.companyId, companyId));
      await db.delete(posTablesTable).where(eq(posTablesTable.companyId, companyId));
      await db.delete(salesInvoicesTable).where(eq(salesInvoicesTable.companyId, companyId));
      await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
      await db.delete(branchesTable).where(eq(branchesTable.companyId, companyId));
      await db.delete(companiesTable).where(and(
        eq(companiesTable.id, companyId),
        eq(companiesTable.nameEn, `${TEST_TAG} restaurant cancellation test`),
        eq(companiesTable.isInternalDemoWorkspace, false),
      ));
    }
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    try { await pool.end(); } catch { /* test process may already be closing */ }
  }
});

test("cancelling a sent order cancels unserved lines and serializes with kitchen updates", async () => {
  const sent = await api(`/api/pos-restaurant/orders/${orderId}/send`, "POST", {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.sentCount, 2);

  for (const status of ["preparing", "ready", "served"] as const) {
    const changed = await api(`/api/pos-restaurant/kitchen/items/${servedLineId}/status`, "PUT", { status });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }

  const [cancelled, competingKitchenUpdate] = await Promise.all([
    api(`/api/pos-restaurant/orders/${orderId}/cancel`, "POST", {}),
    api(`/api/pos-restaurant/kitchen/items/${pendingLineId}/status`, "PUT", { status: "preparing" }),
  ]);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.ok([200, 409].includes(competingKitchenUpdate.status), JSON.stringify(competingKitchenUpdate.body));
  assert.equal(cancelled.body.cancelledLineCount, 1);

  const [order] = await db.select().from(posOrdersTable).where(eq(posOrdersTable.id, orderId));
  const lines = await db.select().from(posOrderItemsTable).where(eq(posOrderItemsTable.orderId, orderId));
  const [table] = await db.select().from(posTablesTable).where(eq(posTablesTable.id, tableId));
  assert.equal(order.status, "cancelled");
  assert.equal(lines.find(line => line.id === servedLineId)?.status, "served");
  assert.equal(lines.find(line => line.id === pendingLineId)?.status, "cancelled");
  assert.equal(table.status, "free");
  assert.equal(table.currentOrderId, null);

  const [replacement] = await db.insert(posOrdersTable).values({
    companyId, branchId, orderNumber: `${TEST_TAG}-REPLACEMENT`,
    channel: "dine_in", tableId, status: "open",
  }).returning({ id: posOrdersTable.id });
  await db.update(posTablesTable).set({ status: "occupied", currentOrderId: replacement.id })
    .where(eq(posTablesTable.id, tableId));
  const repeatedCancel = await api(`/api/pos-restaurant/orders/${orderId}/cancel`, "POST", {});
  assert.equal(repeatedCancel.status, 200, JSON.stringify(repeatedCancel.body));
  const [stillOccupied] = await db.select().from(posTablesTable).where(eq(posTablesTable.id, tableId));
  assert.equal(stillOccupied.currentOrderId, replacement.id);

  await db.update(posOrdersTable).set({ status: "billed" })
    .where(eq(posOrdersTable.id, replacement.id));
  const billedCancel = await api(`/api/pos-restaurant/orders/${replacement.id}/cancel`, "POST", {});
  assert.equal(billedCancel.status, 409, JSON.stringify(billedCancel.body));
  const [stillBilled] = await db.select().from(posOrdersTable).where(eq(posOrdersTable.id, replacement.id));
  assert.equal(stillBilled.status, "billed");
});

test("billing and cancellation cannot both finalize the same restaurant order", async () => {
  const [raceOrder] = await db.insert(posOrdersTable).values({
    companyId,
    branchId,
    orderNumber: `${TEST_TAG}-BILL-CANCEL-RACE`,
    channel: "takeaway",
    status: "open",
  }).returning({ id: posOrdersTable.id });
  const [invoice] = await db.insert(salesInvoicesTable).values({
    companyId,
    branchId,
    docNumber: `${TEST_TAG}-BILL-CANCEL-RACE-INVOICE`,
    invoiceDate: new Date().toISOString().slice(0, 10),
    paymentType: "cash",
    currencyCode: "SAR",
    status: "posted",
  }).returning({ id: salesInvoicesTable.id });

  const [bill, cancel] = await Promise.all([
    api(`/api/pos-restaurant/orders/${raceOrder.id}/bill`, "POST", { salesInvoiceId: invoice.id }),
    api(`/api/pos-restaurant/orders/${raceOrder.id}/cancel`, "POST", {}),
  ]);
  assert.deepEqual([bill.status, cancel.status].sort(), [200, 409]);

  const [finalOrder] = await db.select().from(posOrdersTable)
    .where(eq(posOrdersTable.id, raceOrder.id));
  assert.ok(["billed", "cancelled"].includes(finalOrder.status));
  if (finalOrder.status === "billed") {
    assert.equal(finalOrder.billedInvoiceId, invoice.id);
    assert.equal(cancel.status, 409);
  } else {
    assert.equal(finalOrder.billedInvoiceId, null);
    assert.equal(bill.status, 409);
  }
});
