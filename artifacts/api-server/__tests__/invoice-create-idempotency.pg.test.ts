import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";
import {
  branchesTable,
  companiesTable,
  customersTable,
  db,
  itemsTable,
  pool,
  purchaseInvoicesTable,
  salesInvoicesTable,
  salesQuotationsTable,
  suppliersTable,
  unitsTable,
  usersTable,
} from "@workspace/db";

import app from "../src/app.ts";
import { ensureInvoiceCreateIdempotencySchema } from "../src/lib/ensureSchema.ts";

const TEST_TAG = `tt_invoice_idempotency_${randomBytes(8).toString("hex")}`;
const DATE = "2030-01-15";
let server: http.Server;
let baseUrl = "";
let companyId = 0;
let branchId = 0;
let customerId = 0;
let supplierId = 0;
let itemId = 0;
let unitId = 0;
let token = "";

async function assertOwnedTenant(when: string): Promise<void> {
  const [company] = await db.select({
    nameEn: companiesTable.nameEn,
    isInternalDemoWorkspace: companiesTable.isInternalDemoWorkspace,
  }).from(companiesTable).where(eq(companiesTable.id, companyId));
  assert.ok(company, `${when}: disposable tenant must still exist`);
  assert.equal(company.nameEn, `${TEST_TAG} owned disposable tenant`);
  assert.equal(company.isInternalDemoWorkspace, false);
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${path}?companyId=${companyId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function commonPayload(clientRequestId: string): Record<string, unknown> {
  return {
    clientRequestId,
    invoiceDate: DATE,
    branchId,
    paymentType: "credit",
    currencyCode: "SAR",
    exchangeRate: "1",
    subtotal: "10",
    vatAmount: "0",
    discountAmount: "0",
    totalAmount: "10",
    lines: [{
      itemId,
      itemName: `${TEST_TAG} service`,
      itemCode: `${TEST_TAG}-ITEM`,
      unitId,
      unit: "وحدة",
      qty: "1",
      unitPrice: "10",
      vatRate: "0",
      lineTotal: "10",
    }],
  };
}

before(async () => {
  await ensureInvoiceCreateIdempotencySchema();
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const preexisting = await db.select({ id: companiesTable.id }).from(companiesTable)
    .where(eq(companiesTable.nameEn, `${TEST_TAG} owned disposable tenant`));
  assert.equal(preexisting.length, 0, "test tenant marker unexpectedly already exists");

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${TEST_TAG} شركة اختبار معزولة`,
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
    // This is deliberately not a demo workspace: the demo quota middleware
    // correctly blocks unregistered demo writes before invoice routing.
    isInternalDemoWorkspace: false,
  }).returning({ id: companiesTable.id });
  companyId = company.id;
  const [branch] = await db.insert(branchesTable).values({
    companyId, code: `${TEST_TAG}-BR`, nameAr: "فرع اختبار", nameEn: "Test branch",
  }).returning({ id: branchesTable.id });
  branchId = branch.id;
  const [customer] = await db.insert(customersTable).values({
    companyId, nameAr: `${TEST_TAG} عميل`,
  }).returning({ id: customersTable.id });
  customerId = customer.id;
  const [supplier] = await db.insert(suppliersTable).values({
    companyId, nameAr: `${TEST_TAG} مورد`,
  }).returning({ id: suppliersTable.id });
  supplierId = supplier.id;
  const [unit] = await db.insert(unitsTable).values({
    companyId, code: `${TEST_TAG}-UNIT`, nameAr: "وحدة", nameEn: "Unit",
  }).returning({ id: unitsTable.id });
  unitId = unit.id;
  const [item] = await db.insert(itemsTable).values({
    companyId,
    code: `${TEST_TAG}-ITEM`,
    nameAr: `${TEST_TAG} خدمة`,
    itemType: "service",
    unitId,
  }).returning({ id: itemsTable.id });
  itemId = item.id;
  token = `tt_tenant_admin_${randomBytes(16).toString("hex")}`;
  await db.insert(usersTable).values({
    username: `${TEST_TAG}_tenant_admin`,
    passwordHash: "not-used-by-token-fixture",
    // Invoice routes resolve their scope from authUser.companyId, rather than
    // the query parameter that SuperAdmin-only routes accept.
    role: "admin",
    isActive: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  });
  await assertOwnedTenant("fixture setup");
});

after(async () => {
  try {
    await assertOwnedTenant("before cleanup");
    await db.execute(sql`DELETE FROM invoice_create_idempotency WHERE company_id = ${companyId}`);
    await db.delete(salesQuotationsTable).where(eq(salesQuotationsTable.companyId, companyId));
    await db.delete(salesInvoicesTable).where(eq(salesInvoicesTable.companyId, companyId));
    await db.delete(purchaseInvoicesTable).where(eq(purchaseInvoicesTable.companyId, companyId));
    await db.delete(itemsTable).where(eq(itemsTable.companyId, companyId));
    await db.delete(unitsTable).where(eq(unitsTable.companyId, companyId));
    await db.delete(customersTable).where(eq(customersTable.companyId, companyId));
    await db.delete(suppliersTable).where(eq(suppliersTable.companyId, companyId));
    await db.delete(branchesTable).where(eq(branchesTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.sessionToken, token));
    await db.delete(companiesTable).where(and(
      eq(companiesTable.id, companyId),
      eq(companiesTable.nameEn, `${TEST_TAG} owned disposable tenant`),
      eq(companiesTable.isInternalDemoWorkspace, false),
    ));
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await pool.end(); } catch { /* test process may have closed it */ }
  }
});

test("six concurrent invoice POST retries create one draft per invoice kind", async () => {
  const salesKey = randomUUID();
  const purchaseKey = randomUUID();
  const [sales, purchases] = await Promise.all([
    Promise.all(Array.from({ length: 6 }, () => post("/api/sales/sales-invoices", {
      ...commonPayload(salesKey), customerId, docNumber: `${TEST_TAG}-SALE`,
    }))),
    Promise.all(Array.from({ length: 6 }, () => post("/api/purchasing/purchase-invoices", {
      ...commonPayload(purchaseKey), supplierId, docNumber: `${TEST_TAG}-PURCHASE`,
    }))),
  ]);

  for (const responses of [sales, purchases]) {
    assert.equal(responses.filter((response) => response.status === 201).length, 1,
      `only the request which creates the draft may return 201: ${JSON.stringify(responses)}`);
    assert.equal(responses.filter((response) => response.status === 200).length, 5);
    assert.equal(new Set(responses.map((response) => response.body.id)).size, 1,
      "all retries must receive the same invoice id");
    assert.equal(new Set(responses.map((response) => response.body.docNumber)).size, 1,
      "all retries must receive the original document number");
  }

  const [salesRows, purchaseRows] = await Promise.all([
    db.select({ id: salesInvoicesTable.id }).from(salesInvoicesTable)
      .where(eq(salesInvoicesTable.companyId, companyId)),
    db.select({ id: purchaseInvoicesTable.id }).from(purchaseInvoicesTable)
      .where(eq(purchaseInvoicesTable.companyId, companyId)),
  ]);
  assert.equal(salesRows.length, 1);
  assert.equal(purchaseRows.length, 1);

  const changedRetry = await post("/api/sales/sales-invoices", {
    ...commonPayload(salesKey), customerId, notes: "changed payload must not overwrite the draft",
  });
  assert.equal(changedRetry.status, 200);
  assert.equal(changedRetry.body.id, sales[0].body.id);
  assert.equal(changedRetry.body.notes, null);
  await assertOwnedTenant("after idempotency assertions");
});

test("concurrent source-quotation conversion rolls back the losing idempotency claim", async () => {
  const [quotation] = await db.insert(salesQuotationsTable).values({
    companyId,
    branchId,
    customerId,
    docNumber: `${TEST_TAG}-QUOTE`,
    quotationDate: DATE,
    status: "accepted",
  }).returning({ id: salesQuotationsTable.id });
  const firstKey = randomUUID();
  const secondKey = randomUUID();
  const conversions = await Promise.all([
    post("/api/sales/sales-invoices", {
      ...commonPayload(firstKey),
      customerId,
      sourceQuotationId: quotation.id,
      docNumber: `${TEST_TAG}-QUOTE-CONVERT-A`,
    }),
    post("/api/sales/sales-invoices", {
      ...commonPayload(secondKey),
      customerId,
      sourceQuotationId: quotation.id,
      docNumber: `${TEST_TAG}-QUOTE-CONVERT-B`,
    }),
  ]);
  assert.equal(conversions.filter((response) => response.status === 201).length, 1,
    `one source quotation conversion must win: ${JSON.stringify(conversions)}`);
  assert.equal(conversions.filter((response) => response.status === 409).length, 1,
    `the competing conversion must be rejected: ${JSON.stringify(conversions)}`);

  const winner = conversions.find((response) => response.status === 201)!;
  const [converted] = await db.select({
    status: salesQuotationsTable.status,
    convertedInvoiceId: salesQuotationsTable.convertedInvoiceId,
  }).from(salesQuotationsTable).where(eq(salesQuotationsTable.id, quotation.id));
  assert.deepEqual(converted, { status: "converted", convertedInvoiceId: winner.body.id });

  const quoteInvoices = await db.select({ id: salesInvoicesTable.id })
    .from(salesInvoicesTable)
    .where(and(
      eq(salesInvoicesTable.companyId, companyId),
      sql`${salesInvoicesTable.docNumber} IN (${`${TEST_TAG}-QUOTE-CONVERT-A`}, ${`${TEST_TAG}-QUOTE-CONVERT-B`})`,
    ));
  assert.equal(quoteInvoices.length, 1, "the losing conversion must not leave an invoice behind");

  const losingKey = (conversions[0].status === 409 ? firstKey : secondKey);
  const replayRows = await db.execute(sql`
    SELECT 1 FROM invoice_create_idempotency
     WHERE company_id = ${companyId}
       AND invoice_kind = 'sales_invoice'
       AND client_request_id = ${losingKey}`);
  const rows = Array.isArray(replayRows) ? replayRows : (replayRows as any).rows;
  assert.equal(rows.length, 0, "the losing conversion must not leave a replay claim");
});