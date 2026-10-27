import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../src/routes/additional-purchase-reports.ts", import.meta.url), "utf8");
const menu = await readFile(new URL("../../zatca-invoicing/src/lib/menuItems.ts", import.meta.url), "utf8");
const filters = await readFile(new URL("../../zatca-invoicing/src/pages/AdditionalOperationalReports.tsx", import.meta.url), "utf8");

test("direct-expense purchase report is registered in the server and purchase report menu", () => {
  assert.match(route, /"direct_expense_purchases"/);
  assert.match(menu, /\{ id: "direct_expense_purchases", label: "مصروفات فواتير الشراء المباشرة" \}/);
  assert.match(filters, /direct_expense_purchases: \["branchId", "supplierId", "accountId", "paymentType"\]/);
});

test("direct-expense purchase report is tenant-, status-, visibility-, and branch-scoped", () => {
  const start = route.indexOf('if (id === "direct_expense_purchases")');
  const end = route.indexOf('if (id === "invoice_status")', start);
  const branch = route.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(branch, /eq\(purchaseInvoicesTable\.companyId, cid\)/);
  assert.match(branch, /eq\(purchaseInvoicesTable\.status, "posted"\)/);
  assert.match(branch, /eq\(\(purchaseInvoiceLinesTable as any\)\.lineType, "direct_expense"\)/);
  assert.match(branch, /ownDocumentFilter\(req, "purchaseReportsOwn"/);
  assert.match(branch, /pushBranchScope\(req, conditions, purchaseInvoicesTable\.branchId, q\.branchId\)/);
  assert.match(branch, /eq\(accountsTable\.companyId, cid\)/);
});
