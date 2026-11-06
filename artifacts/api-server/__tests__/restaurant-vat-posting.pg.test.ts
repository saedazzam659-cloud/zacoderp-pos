import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  accountsTable,
  branchesTable,
  cashBoxesTable,
  companiesTable,
  db,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  pool,
  posMenuCategoriesTable,
  posMenuItemsTable,
  posOrdersTable,
  salesInvoicesTable,
  salesInvoiceLinesTable,
  salesReturnsTable,
  salesReturnLinesTable,
  unitsTable,
  usersTable,
} from "@workspace/db";
import type { ROrderItem } from "../../pos/src/lib/api.ts";
import { buildRestaurantInvoicePricing } from "../../pos/src/lib/restaurant-pricing.ts";
import app from "../src/app.ts";

const TEST_TAG = `tt_restaurant_vat_${randomBytes(8).toString("hex")}`;
const DATE = new Date().toISOString().slice(0, 10);
let server: http.Server | undefined;
let baseUrl = "";
let companyId = 0;
let branchId = 0;
let cashBoxId = 0;
let cogsAccountId = 0;
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
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${TEST_TAG} شركة اختبار`,
    nameEn: `${TEST_TAG} owned disposable tenant`,
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
    menuPermissions: JSON.stringify({ invoices: true, pos_waiter: true }),
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  const [branch] = await db.insert(branchesTable).values({
    companyId,
    code: `${TEST_TAG}-BR`,
    nameAr: "فرع اختبار",
    nameEn: "Test branch",
  }).returning({ id: branchesTable.id });
  branchId = branch.id;

  const [unit] = await db.insert(unitsTable).values({
    companyId,
    code: `${TEST_TAG}-UNIT`,
    nameAr: "وحدة",
    nameEn: "Unit",
  }).returning({ id: unitsTable.id });

  const [revenue] = await db.insert(accountsTable).values({
    companyId, code: "4101", nameAr: "إيراد الاختبار", accountType: "revenue",
  }).returning({ id: accountsTable.id });
  const [cogsAccount] = await db.insert(accountsTable).values({
    companyId, code: "5101", nameAr: "تكلفة مبيعات الاختبار", accountType: "expense",
  }).returning({ id: accountsTable.id });
  cogsAccountId = cogsAccount.id;
  await db.insert(accountsTable).values({
    companyId, code: "21041", nameAr: "ضريبة مخرجات الاختبار", accountType: "liability",
  });
  const [cashAccount] = await db.insert(accountsTable).values({
    companyId, code: "1101", nameAr: "نقدية الاختبار", accountType: "asset",
  }).returning({ id: accountsTable.id });
  const [cashBox] = await db.insert(cashBoxesTable).values({
    companyId,
    branchId,
    code: `${TEST_TAG}-CASH`,
    nameAr: "خزنة اختبار",
    accountId: cashAccount.id,
  }).returning({ id: cashBoxesTable.id });
  cashBoxId = cashBox.id;

  token = `tt_restaurant_vat_${randomBytes(16).toString("hex")}`;
  await db.insert(usersTable).values({
    username: `${TEST_TAG}_admin`,
    passwordHash: "unused-test-token",
    role: "admin",
    isActive: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  });

  const rates = [
    { code: "INCL", name: "شامل", rate: "15", price: "115", vatIncluded: true },
    { code: "EXCL", name: "غير شامل", rate: "15", price: "100", vatIncluded: false },
    { code: "ZERO", name: "صفر", rate: "0", price: "50", vatIncluded: true },
  ];
  const itemIds: number[] = [];
  for (const item of rates) {
    const [erpItem] = await db.insert(itemsTable).values({
      companyId,
      code: `${TEST_TAG}-${item.code}`,
      nameAr: `${TEST_TAG} ${item.name}`,
      itemType: "service",
      unitId: unit.id,
      vatRate: item.rate,
    }).returning({ id: itemsTable.id });
    itemIds.push(erpItem.id);
  }

  const [category] = await db.insert(posMenuCategoriesTable).values({
    companyId,
    code: `${TEST_TAG}-CAT`,
    nameAr: "اختبار ضريبة المطعم",
  }).returning({ id: posMenuCategoriesTable.id });
  await db.insert(posMenuItemsTable).values(rates.map((item, index) => ({
      companyId,
      categoryId: category.id,
      code: `${TEST_TAG}-${item.code}`,
      nameAr: item.name,
      price: item.price,
      itemId: itemIds[index],
      vatIncluded: item.vatIncluded,
  })));

  // Ensure the post path uses the tenant-owned revenue mapping.
  assert.ok(revenue.id > 0);
});

after(async () => {
  try {
    if (companyId) {
      // Remove only rows owned by this uniquely tagged disposable tenant.
      await db.execute(sql`DELETE FROM pos_order_items WHERE order_id IN
        (SELECT id FROM pos_orders WHERE company_id = ${companyId})`);
      await db.delete(posOrdersTable).where(eq(posOrdersTable.companyId, companyId));
      await db.delete(posMenuItemsTable).where(eq(posMenuItemsTable.companyId, companyId));
      await db.delete(posMenuCategoriesTable).where(eq(posMenuCategoriesTable.companyId, companyId));
      await db.delete(salesReturnLinesTable).where(eq(salesReturnLinesTable.companyId, companyId));
      const returns = await db.select({
        id: salesReturnsTable.id,
        journalEntryId: salesReturnsTable.journalEntryId,
      }).from(salesReturnsTable).where(eq(salesReturnsTable.companyId, companyId));
      const returnJournalEntryIds = [...new Set(returns
        .map(ret => ret.journalEntryId)
        .filter((id): id is number => id != null))];
      if (returnJournalEntryIds.length) {
        await db.update(salesReturnsTable).set({ journalEntryId: null })
          .where(inArray(salesReturnsTable.id, returns.map(ret => ret.id)));
        await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, returnJournalEntryIds));
      }
      await db.delete(salesReturnsTable).where(eq(salesReturnsTable.companyId, companyId));
      if (returnJournalEntryIds.length) {
        await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, returnJournalEntryIds));
      }
      await db.delete(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.companyId, companyId));
      const invoices = await db.select({
        id: salesInvoicesTable.id,
        journalEntryId: salesInvoicesTable.journalEntryId,
      }).from(salesInvoicesTable).where(eq(salesInvoicesTable.companyId, companyId));
      const journalEntryIds = [...new Set(invoices
        .map(invoice => invoice.journalEntryId)
        .filter((id): id is number => id != null))];
      if (journalEntryIds.length) {
        await db.update(salesInvoicesTable).set({ journalEntryId: null })
          .where(inArray(salesInvoicesTable.id, invoices.map(invoice => invoice.id)));
        await db.delete(journalEntryLinesTable).where(inArray(journalEntryLinesTable.entryId, journalEntryIds));
      }
      await db.delete(salesInvoicesTable).where(eq(salesInvoicesTable.companyId, companyId));
      if (journalEntryIds.length) {
        await db.delete(journalEntriesTable).where(inArray(journalEntriesTable.id, journalEntryIds));
      }
      await db.delete(cashBoxesTable).where(eq(cashBoxesTable.companyId, companyId));
      await db.delete(itemsTable).where(eq(itemsTable.companyId, companyId));
      await db.delete(unitsTable).where(eq(unitsTable.companyId, companyId));
      await db.delete(accountsTable).where(eq(accountsTable.companyId, companyId));
      await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
      await db.delete(branchesTable).where(eq(branchesTable.companyId, companyId));
      await db.delete(companiesTable).where(and(
        eq(companiesTable.id, companyId),
        eq(companiesTable.nameEn, `${TEST_TAG} owned disposable tenant`),
        eq(companiesTable.isInternalDemoWorkspace, false),
      ));
    }
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    try { await pool.end(); } catch { /* test process may already be closing */ }
  }
});

test("restaurant order VAT matches a posted sales invoice and the billed order", async () => {
  const createdOrder = await api("/api/pos-restaurant/orders", "POST", {
    branchId,
    channel: "takeaway",
  });
  assert.equal(createdOrder.status, 201, JSON.stringify(createdOrder.body));
  const orderId = Number(createdOrder.body.id);

  const items = await api("/api/pos-restaurant/menu/items", "GET");
  assert.equal(items.status, 200, JSON.stringify(items.body));
  for (const menuItem of items.body as Array<{ id: number }>) {
    const added = await api(`/api/pos-restaurant/orders/${orderId}/items`, "POST", {
      menuItemId: menuItem.id,
      qty: 1,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
  }

  const openOrder = await api(`/api/pos-restaurant/orders/${orderId}`, "GET");
  assert.equal(openOrder.status, 200, JSON.stringify(openOrder.body));
  const pricing = buildRestaurantInvoicePricing(openOrder.body.items as ROrderItem[], null);
  assert.deepEqual(
    { subtotal: Number(openOrder.body.subtotal), vatAmount: Number(openOrder.body.vatAmount), total: Number(openOrder.body.total) },
    { subtotal: pricing.subtotal, vatAmount: pricing.vatAmount, total: pricing.totalAmount },
  );
  assert.deepEqual(
    { subtotal: pricing.subtotal, vatAmount: pricing.vatAmount, total: pricing.totalAmount },
    { subtotal: 250, vatAmount: 30, total: 280 },
  );
  assert.ok(pricing.lines.some(line => line.vatRate === 0), "the zero-rate item must remain zero-rated");

  const draft = await api("/api/sales/sales-invoices", "POST", {
    clientRequestId: `restaurant-order-${orderId}`,
    docNumber: `${TEST_TAG}-INVOICE`,
    invoiceDate: DATE,
    branchId,
    paymentType: "cash",
    cashBoxId,
    currencyCode: "SAR",
    subtotal: pricing.subtotal,
    vatAmount: pricing.vatAmount,
    discountAmount: 0,
    totalAmount: pricing.totalAmount,
    priceIncludesVat: true,
    lines: pricing.lines,
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const invoiceId = Number(draft.body.id);

  const posted = await api(`/api/sales/sales-invoices/${invoiceId}/post`, "PATCH", {});
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.status, "posted");

  const linked = await api(`/api/pos-restaurant/orders/${orderId}/bill`, "POST", {
    salesInvoiceId: invoiceId,
  });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));

  const [invoice] = await db.select().from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.id, invoiceId));
  assert.equal(invoice.status, "posted");
  assert.equal(Number(invoice.subtotal), pricing.subtotal);
  assert.equal(Number(invoice.vatAmount), pricing.vatAmount);
  assert.equal(Number(invoice.totalAmount), pricing.totalAmount);
  const invoiceLines = await db.select({
    itemId: salesInvoiceLinesTable.itemId,
    vatRate: salesInvoiceLinesTable.vatRate,
  }).from(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, invoiceId));
  assert.equal(invoiceLines.length, 3);
  assert.deepEqual(invoiceLines.map(line => Number(line.vatRate)).sort((a, b) => a - b), [0, 15, 15]);

  const billedOrder = await api(`/api/pos-restaurant/orders/${orderId}`, "GET");
  assert.equal(billedOrder.status, 200, JSON.stringify(billedOrder.body));
  assert.equal(billedOrder.body.status, "billed");
  assert.equal(billedOrder.body.billedInvoiceId, invoiceId);
  assert.deepEqual(
    { subtotal: Number(billedOrder.body.subtotal), vatAmount: Number(billedOrder.body.vatAmount), total: Number(billedOrder.body.total) },
    { subtotal: Number(invoice.subtotal), vatAmount: Number(invoice.vatAmount), total: Number(invoice.totalAmount) },
  );

  const sourceLines = await db.select().from(salesInvoiceLinesTable)
    .where(eq(salesInvoiceLinesTable.invoiceId, invoiceId))
    .orderBy(asc(salesInvoiceLinesTable.id));
  const sourceLine = sourceLines[0];
  const returnGross = Number(sourceLine.lineTotal);
  const returnVat = Number((returnGross - returnGross / (1 + Number(sourceLine.vatRate) / 100)).toFixed(2));
  const createdReturn = await api("/api/sales/sales-returns", "POST", {
    returnDate: DATE,
    branchId,
    invoiceId,
    paymentType: "cash",
    cashBoxId,
    currencyCode: "SAR",
    totalAmount: returnGross,
    vatAmount: returnVat,
    discountAmount: 0,
    priceIncludesVat: true,
    cogsAccountId,
    notes: `${TEST_TAG} restaurant invoice return`,
    lines: [{
      sourceLineId: sourceLine.id,
      itemId: sourceLine.itemId,
      itemName: sourceLine.itemName,
      itemCode: sourceLine.itemCode,
      unit: sourceLine.unit,
      unitId: sourceLine.unitId,
      conversionFactor: Number(sourceLine.conversionFactor ?? 1),
      warehouseId: sourceLine.warehouseId,
      qty: 1,
      freeQty: 0,
      unitPrice: Number(sourceLine.unitPrice),
      discount: Number(sourceLine.discount),
      vatRate: Number(sourceLine.vatRate),
      lineTotal: returnGross,
    }],
  });
  assert.equal(createdReturn.status, 201, JSON.stringify(createdReturn.body));

  const postedReturn = await api(`/api/sales/sales-returns/${createdReturn.body.id}/post`, "PATCH", {});
  assert.equal(postedReturn.status, 200, JSON.stringify(postedReturn.body));
  const [savedReturn] = await db.select().from(salesReturnsTable)
    .where(eq(salesReturnsTable.id, Number(createdReturn.body.id)));
  assert.equal(savedReturn.status, "posted");
  assert.equal(savedReturn.invoiceId, invoiceId);
  assert.equal(Number(savedReturn.totalAmount), returnGross);
  assert.equal(Number(savedReturn.vatAmount), returnVat);
  assert.ok(savedReturn.journalEntryId, "the linked return should post through normal sales accounting");

  const blockedUnpost = await api(`/api/sales/sales-invoices/${invoiceId}/unpost`, "PATCH", {});
  assert.equal(blockedUnpost.status, 409, JSON.stringify(blockedUnpost.body));
});
