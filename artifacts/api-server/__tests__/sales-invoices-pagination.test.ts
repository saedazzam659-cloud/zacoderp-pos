import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { boundedOffsetPage } from "../src/lib/boundedPagination.ts";

import { and, eq, inArray } from "drizzle-orm";
import {
  branchesTable,
  companiesTable,
  customersTable,
  db,
  pool,
  receiptVouchersTable,
  salesInvoicesTable,
  salesQuotationsTable,
  userBranchesTable,
  usersTable,
} from "@workspace/db";

import app from "../src/app.ts";
import { effectiveLineDiscount, findOldestOutstandingCredit } from "../src/routes/sales.ts";

const tag = `tt_sales_page_${randomBytes(4).toString("hex")}`;
const token = `${tag}_${randomBytes(12).toString("hex")}`;

let server: http.Server;
let baseUrl = "";
let companyId = 0;
let branch1Id = 0;
let branch2Id = 0;
let customer1Id = 0;
let customer2Id = 0;
let userId = 0;
let restrictedUserId = 0;
let restrictedToken = "";
let receiptId = 0;
const invoiceIds: number[] = [];
const quotationIds: number[] = [];

type PagedResponse = {
  items: Array<{ id: number; docNumber: string | null; status: string; branchId: number | null; customerName?: string | null }>;
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  accessibleTotal: number;
  truncated: boolean;
  summary: {
    totalInvoices: number;
    postedInvoices: number;
    draftInvoices: number;
    totalPostedAmount: number;
  };
};

async function api<T>(query = "", withToken = true): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/sales/sales-invoices${query}`, {
    headers: withToken ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() as T };
}

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [company] = await db.insert(companiesTable).values({
    nameAr: `شركة اختبار ترقيم الفواتير ${tag}`,
    nameEn: `Sales pagination ${tag}`,
    vatNumber: `3${randomBytes(7).toString("hex").slice(0, 14)}`,
    crNumber: `CR-${tag}`,
    city: "Riyadh",
    street: "Test",
    buildingNumber: "1",
    postalCode: "12345",
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  const branches = await db.insert(branchesTable).values([
    { companyId, code: `${tag}-B1`, nameAr: "فرع أول" },
    { companyId, code: `${tag}-B2`, nameAr: "فرع ثان" },
  ]).returning({ id: branchesTable.id });
  branch1Id = branches[0].id;
  branch2Id = branches[1].id;

  const customers = await db.insert(customersTable).values([
    { companyId, nameAr: `عميل ألفا ${tag}` },
    { companyId, nameAr: `عميل بيتا ${tag}` },
  ]).returning({ id: customersTable.id });
  customer1Id = customers[0].id;
  customer2Id = customers[1].id;

  const [user] = await db.insert(usersTable).values({
    username: `${tag}_sa`,
    passwordHash: "not-used",
    role: "superadmin",
    isActive: true,
    sessionToken: token,
    sessionId: "test",
    companyId: null,
  }).returning({ id: usersTable.id });
  userId = user.id;

  restrictedToken = `${tag}_restricted_${randomBytes(8).toString("hex")}`;
  const [restrictedUser] = await db.insert(usersTable).values({
    username: `${tag}_restricted`,
    passwordHash: "not-used",
    role: "user",
    isActive: true,
    companyId,
    viewAllBranches: false,
    permissions: { sales_invoices: { view: true, create: true } },
    sessionToken: restrictedToken,
    sessionId: "test-restricted",
  }).returning({ id: usersTable.id });
  restrictedUserId = restrictedUser.id;
  await db.insert(userBranchesTable).values({ userId: restrictedUserId, branchId: branch1Id });

  const invoices = await db.insert(salesInvoicesTable).values([
    { companyId, branchId: branch1Id, customerId: customer1Id, docNumber: `${tag}-001`, invoiceDate: "2026-08-18", status: "posted", paymentType: "credit", totalAmount: "100.00" },
    { companyId, branchId: branch1Id, customerId: customer2Id, docNumber: `${tag}-002`, invoiceDate: "2026-08-19", status: "draft", paymentType: "credit", totalAmount: "200.00" },
    { companyId, branchId: branch1Id, customerId: customer1Id, docNumber: `${tag}-003`, invoiceDate: "2026-08-19", status: "posted", paymentType: "credit", totalAmount: "300.00" },
    { companyId, branchId: branch2Id, customerId: customer2Id, docNumber: `${tag}-004`, invoiceDate: "2026-08-17", status: "posted", paymentType: "credit", totalAmount: "400.00" },
    { companyId, branchId: branch2Id, customerId: customer1Id, docNumber: `${tag}-005`, invoiceDate: "2026-08-16", status: "cancelled", paymentType: "credit", totalAmount: "500.00" },
  ]).returning({ id: salesInvoicesTable.id });
  invoiceIds.push(...invoices.map((row) => row.id));
});

after(async () => {
  try {
    if (receiptId) await db.delete(receiptVouchersTable).where(eq(receiptVouchersTable.id, receiptId));
    if (invoiceIds.length) {
      await db.delete(salesInvoicesTable).where(inArray(salesInvoicesTable.id, invoiceIds));
    }
    if (quotationIds.length) {
      await db.delete(salesQuotationsTable).where(inArray(salesQuotationsTable.id, quotationIds));
    }
    if (customer1Id || customer2Id) {
      await db.delete(customersTable).where(inArray(customersTable.id, [customer1Id, customer2Id].filter(Boolean)));
    }
    if (branch1Id || branch2Id) {
      await db.delete(branchesTable).where(inArray(branchesTable.id, [branch1Id, branch2Id].filter(Boolean)));
    }
    if (restrictedUserId) await db.delete(usersTable).where(eq(usersTable.id, restrictedUserId));
    if (companyId) await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await pool.end(); } catch { /* already closed */ }
  }
});

test("sales invoice list still requires authentication", async () => {
  const response = await api<unknown>(`?companyId=${companyId}`, false);
  assert.equal(response.status, 401);
});

test("legacy list remains a bare array with deterministic date/id ordering", async () => {
  const response = await api<Array<{ id: number; invoiceDate: string }>>(`?companyId=${companyId}`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  assert.equal(response.body.length, 5);
  const sameDateRows = response.body.filter((row) => row.invoiceDate === "2026-08-19");
  assert.deepEqual(sameDateRows.map((row) => row.id), [...sameDateRows.map((row) => row.id)].sort((a, b) => b - a));
});

test("opt-in paging limits enrichment to the requested page and returns global summary", async () => {
  const response = await api<PagedResponse>(`?companyId=${companyId}&paged=1&page=1&pageSize=2`);
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageSize, 2);
  assert.equal(response.body.total, 5);
  assert.equal(response.body.pageCount, 3);
  assert.ok(response.body.items.every((row) => typeof row.customerName === "string"));
  assert.deepEqual(response.body.summary, {
    totalInvoices: 5,
    postedInvoices: 3,
    draftInvoices: 1,
    totalPostedAmount: 800,
  });
});

test("paged status, customer search, and branch filters are applied before paging", async () => {
  const status = await api<PagedResponse>(`?companyId=${companyId}&paged=1&status=posted&pageSize=10`);
  assert.equal(status.body.total, 3);
  assert.ok(status.body.items.every((row) => row.status === "posted"));

  const search = await api<PagedResponse>(
    `?companyId=${companyId}&paged=1&search=${encodeURIComponent("عميل ألفا")}&pageSize=10`,
  );
  assert.equal(search.body.total, 3);
  assert.ok(search.body.items.every((row) => row.docNumber !== `${tag}-002` && row.docNumber !== `${tag}-004`));

  const branch = await api<PagedResponse>(
    `?companyId=${companyId}&paged=1&branchIds=${branch1Id}&pageSize=10`,
  );
  assert.equal(branch.body.total, 3);
  assert.ok(branch.body.items.every((row) => row.branchId === branch1Id));
  assert.equal(branch.body.summary.totalInvoices, 3);
  assert.equal(branch.body.summary.totalPostedAmount, 400);
});

test("paged mode keeps restricted users inside their assigned branches", async () => {
  const allowed = await fetch(`${baseUrl}/api/sales/sales-invoices?paged=1&pageSize=10`, {
    headers: { Authorization: `Bearer ${restrictedToken}` },
  });
  assert.equal(allowed.status, 200);
  const allowedBody = await allowed.json() as PagedResponse;
  assert.equal(allowedBody.total, 3);
  assert.ok(allowedBody.items.every((row) => row.branchId === branch1Id));

  const denied = await fetch(
    `${baseUrl}/api/sales/sales-invoices?paged=1&pageSize=10&branchIds=${branch2Id}`,
    { headers: { Authorization: `Bearer ${restrictedToken}` } },
  );
  assert.equal(denied.status, 200);
  const deniedBody = await denied.json() as PagedResponse;
  assert.equal(deniedBody.total, 0);
  assert.deepEqual(deniedBody.items, []);
});

test("paged list clamps pageSize to its server-side safety ceiling", async () => {
  const response = await api<PagedResponse>(`?companyId=${companyId}&paged=1&pageSize=999`);
  assert.equal(response.body.pageSize, 100);
});

test("paged list bounds adversarially deep offsets", async () => {
  const response = await api<PagedResponse>(`?companyId=${companyId}&paged=1&page=1000000000000000000&pageSize=10`);
  assert.equal(response.status, 200);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.pageCount, 1);
  assert.equal(response.body.items.length, 5);
});

test("sales invoice create still succeeds through the combined quota query", async () => {
  const response = await fetch(`${baseUrl}/api/sales/sales-invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restrictedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      branchId: branch1Id,
      customerId: customer2Id,
      docNumber: `${tag}-CREATE`,
      invoiceDate: "2026-08-20",
      paymentType: "credit",
      subtotal: "0",
      vatAmount: "0",
      discountAmount: "0",
      totalAmount: "0",
      lines: [],
    }),
  });
  const body = await response.json() as { id?: number; status?: string; error?: string };
  assert.equal(response.status, 201, body.error);
  assert.equal(body.status, "draft");
  assert.ok(body.id);
  invoiceIds.push(body.id!);
});

test("issue-only mobile save cannot leave an unauthorized draft behind", async () => {
  await db.update(usersTable).set({
    sessionChannel: "mobile",
    mobilePermissions: {
      invoice_create: true,
      invoice_save_draft: false,
      invoice_save_issue: true,
    },
  }).where(eq(usersTable.id, restrictedUserId));

  const docNumber = `${tag}-ISSUE-ONLY`;
  const response = await fetch(`${baseUrl}/api/sales/sales-invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restrictedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mobileSaveMode: "issue",
      branchId: branch1Id,
      customerId: customer2Id,
      docNumber,
      invoiceDate: "2026-08-20",
      paymentType: "credit",
      subtotal: "0",
      vatAmount: "0",
      discountAmount: "0",
      totalAmount: "0",
      lines: [],
    }),
  });
  assert.equal(response.status, 400);
  let retained: Array<{ id: number }> = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    retained = await db.select({ id: salesInvoicesTable.id })
      .from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.companyId, companyId), eq(salesInvoicesTable.docNumber, docNumber)));
    if (retained.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(retained, []);
});

test("mobile rejects negative free quantity before persistence", async () => {
  const docNumber = `${tag}-NEG-FREE`;
  const response = await fetch(`${baseUrl}/api/sales/sales-invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restrictedToken}`,
      "Content-Type": "application/json",
      "x-app-channel": "mobile",
    },
    body: JSON.stringify({
      mobileSaveMode: "draft",
      branchId: branch1Id,
      customerId: customer2Id,
      docNumber,
      invoiceDate: "2026-08-20",
      paymentType: "credit",
      subtotal: "100",
      vatAmount: "15",
      discountAmount: "0",
      totalAmount: "115",
      lines: [{ itemId: 999999, itemName: "اختبار", qty: 1, freeQty: -1, unitPrice: 100, vatRate: 15 }],
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error?: string };
  assert.match(body.error ?? "", /الكمية المجانية/);
  const retained = await db.select({ id: salesInvoicesTable.id })
    .from(salesInvoicesTable)
    .where(and(eq(salesInvoicesTable.companyId, companyId), eq(salesInvoicesTable.docNumber, docNumber)));
  assert.deepEqual(retained, []);
});

test("failed inline issue restores its accepted source quotation", async () => {
  const [quotation] = await db.insert(salesQuotationsTable).values({
    companyId,
    branchId: branch1Id,
    customerId: customer2Id,
    docNumber: `${tag}-QUOTE`,
    quotationDate: "2026-08-20",
    status: "accepted",
  }).returning({ id: salesQuotationsTable.id });
  quotationIds.push(quotation.id);
  const docNumber = `${tag}-QUOTE-ISSUE`;
  const response = await fetch(`${baseUrl}/api/sales/sales-invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restrictedToken}`,
      "Content-Type": "application/json",
      "x-app-channel": "mobile",
    },
    body: JSON.stringify({
      mobileSaveMode: "issue",
      sourceQuotationId: quotation.id,
      branchId: branch1Id,
      customerId: customer2Id,
      docNumber,
      invoiceDate: "2026-08-20",
      paymentType: "credit",
      subtotal: "0",
      vatAmount: "0",
      discountAmount: "0",
      totalAmount: "0",
      lines: [],
    }),
  });
  assert.equal(response.status, 400);
  let restored: Array<{ status: string; convertedInvoiceId: number | null }> = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    restored = await db.select({
      status: salesQuotationsTable.status,
      convertedInvoiceId: salesQuotationsTable.convertedInvoiceId,
    }).from(salesQuotationsTable).where(eq(salesQuotationsTable.id, quotation.id));
    if (restored[0]?.status === "accepted" && restored[0]?.convertedInvoiceId == null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(restored, [{ status: "accepted", convertedInvoiceId: null }]);
  const retained = await db.select({ id: salesInvoicesTable.id })
    .from(salesInvoicesTable)
    .where(and(eq(salesInvoicesTable.companyId, companyId), eq(salesInvoicesTable.docNumber, docNumber)));
  assert.deepEqual(retained, []);
});

test("bounded paging never advertises phantom pages beyond the safe offset", () => {
  const window = boundedOffsetPage(500_000, 50_000, 10);
  assert.deepEqual(window, {
    page: 10_001,
    pageCount: 10_001,
    accessibleTotal: 100_010,
    truncated: true,
  });
});

test("posting uses synchronized discount percentage and amount only once", () => {
  assert.equal(effectiveLineDiscount({ discount: "10", discountAmount: "20" }, 200), 20);
  assert.equal(effectiveLineDiscount({ discount: "10", discountAmount: "0" }, 200), 20);
});

test("overdue FIFO lookup is one-query equivalent before and after a partial receipt", async () => {
  await db.update(customersTable)
    .set({ paymentTermsDays: 10 })
    .where(eq(customersTable.id, customer1Id));

  const beforeReceipt = await findOldestOutstandingCredit(companyId, customer1Id);
  assert.equal(beforeReceipt?.invoiceDate, "2026-08-18");
  assert.equal(beforeReceipt?.outstandingAmount, 100);

  const [receipt] = await db.insert(receiptVouchersTable).values({
    companyId,
    branchId: branch1Id,
    code: `${tag}-RV`,
    date: "2026-08-20",
    paymentType: "cash",
    entityType: "customer",
    entityId: customer1Id,
    amount: "150.00",
    exchangeRate: "1",
    refType: "test",
    status: "posted",
  }).returning({ id: receiptVouchersTable.id });
  receiptId = receipt.id;

  const afterReceipt = await findOldestOutstandingCredit(companyId, customer1Id);
  assert.equal(afterReceipt?.invoiceDate, "2026-08-19");
  assert.equal(afterReceipt?.outstandingAmount, 250);
});
