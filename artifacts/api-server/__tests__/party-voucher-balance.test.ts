import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  supplementalInvoiceLinkedVoucherAllocations,
  supplementalInvoiceLinkedVoucherRowAllocations,
  supplementalInvoiceLinkedVoucherTotals,
} from "../src/lib/partyVoucherBalance.js";

test("entity-linked totals are not part of the supplemental allocator", () => {
  assert.deepEqual(
    Object.fromEntries(supplementalInvoiceLinkedVoucherTotals([], [], [], [])),
    {},
  );
});

test("payment line allocation includes amount and VAT", () => {
  const result = supplementalInvoiceLinkedVoucherTotals(
    [{ id: 1, amount: "115" }],
    [{ id: 10, voucherId: 1, partyId: 7, amount: "115" }],
    [], [],
  );
  assert.equal(result.get(7), 115);
});

test("settlement links are full residual allocations additive to lines", () => {
  const result = supplementalInvoiceLinkedVoucherTotals(
    [{ id: 1, amount: "100" }],
    [{ id: 10, voucherId: 1, partyId: 7, amount: "60" }],
    [{ id: 20, voucherId: 1, partyId: 8, amount: "60" }],
    [],
  );
  assert.deepEqual(Object.fromEntries(result), { 7: 60, 8: 60 });
});

test("header invoice link falls back to header amount only without allocations", () => {
  const result = supplementalInvoiceLinkedVoucherTotals(
    [{ id: 1, amount: "100" }], [], [],
    [{ voucherId: 1, partyId: 7 }],
  );
  assert.equal(result.get(7), 100);
});

test("split allocations and duplicate source rows are counted once", () => {
  const result = supplementalInvoiceLinkedVoucherTotals(
    [{ id: 1, amount: "100" }],
    [
      { id: 10, voucherId: 1, partyId: 7, amount: "40" },
      { id: 10, voucherId: 1, partyId: 7, amount: "40" },
      { id: 11, voucherId: 1, partyId: 8, amount: "60" },
    ],
    [{ id: 20, voucherId: 1, partyId: 7, amount: "100" }],
    [{ voucherId: 1, partyId: 7 }],
  );
  assert.deepEqual(Object.fromEntries(result), { 7: 140, 8: 60 });
});

test("row allocations use the same dedupe and header-fallback contract as totals", () => {
  const rows = supplementalInvoiceLinkedVoucherAllocations(
    [{ id: 1, amount: "100" }, { id: 2, amount: "75" }],
    [
      { id: 10, voucherId: 1, partyId: 7, amount: "46" },
      { id: 10, voucherId: 1, partyId: 7, amount: "46" },
      { id: 11, voucherId: 1, partyId: 8, amount: "54" },
    ],
    [{ id: 20, voucherId: 1, partyId: 7, amount: "15" }],
    [{ voucherId: 1, partyId: 7 }, { voucherId: 2, partyId: 8 }],
  );
  assert.deepEqual(rows, [
    { voucherId: 1, partyId: 7, amount: 46 },
    { voucherId: 1, partyId: 8, amount: 54 },
    { voucherId: 1, partyId: 7, amount: 15 },
    { voucherId: 2, partyId: 8, amount: 75 },
  ]);
});

test("statement row allocations group same-party portions but retain split parties", () => {
  const rows = supplementalInvoiceLinkedVoucherRowAllocations(
    [{ id: 2, amount: "100" }, { id: 1, amount: "100" }],
    [
      { id: 11, voucherId: 1, partyId: 7, amount: "46" },
      { id: 11, voucherId: 1, partyId: 7, amount: "46" },
      { id: 13, voucherId: 1, partyId: 8, amount: "10" },
      { id: 14, voucherId: 1, partyId: 8, amount: "9" },
    ],
    [
      { id: 20, voucherId: 1, partyId: 7, amount: "15" },
      { id: 21, voucherId: 2, partyId: 8, amount: "50" },
      { id: 22, voucherId: 2, partyId: 7, amount: "50" },
    ],
    [],
  );
  assert.deepEqual(rows, [
    { voucherId: 1, partyId: 7, amount: 61 },
    { voucherId: 1, partyId: 8, amount: 19 },
    { voucherId: 2, partyId: 7, amount: 50 },
    { voucherId: 2, partyId: 8, amount: 50 },
  ]);
});

test("invalid portions do not suppress a valid header fallback", () => {
  const rows = supplementalInvoiceLinkedVoucherAllocations(
    [{ id: 1, amount: "75" }],
    [{ id: 10, voucherId: 1, partyId: null, amount: "75" }],
    [{ id: 20, voucherId: 1, partyId: 7, amount: "not-a-number" }],
    [{ voucherId: 1, partyId: 7 }],
  );
  assert.deepEqual(rows, [{ voucherId: 1, partyId: 7, amount: 75 }]);
});

test("report reads limit supplements to posted, tenant-scoped entityId-null vouchers", async () => {
  const source = await readFile(new URL("../src/routes/purchases-analytics.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function supplierInvoiceLinkedVoucherTotals");
  const end = source.indexOf("\n/**", start);
  const helper = source.slice(start, end);
  assert.match(helper, /eq\(paymentVouchersTable\.companyId, cid\)/);
  assert.match(helper, /eq\(paymentVouchersTable\.status, "posted"\)/);
  assert.match(helper, /isNull\(paymentVouchersTable\.entityId\)/);
  assert.match(helper, /eq\(purchaseInvoicesTable\.companyId, cid\)/);
  assert.match(helper, /eq\(purchaseInvoicesTable\.status, "posted"\)/);
  assert.match(helper, /paymentVoucherLinesTable\.amount} \+ coalesce\(\$\{paymentVoucherLinesTable\.taxAmount\}, 0\)/);
  assert.match(helper, /\.\.\.dateConds/);
  assert.match(helper, /branchScopeSpread\(req, paymentVouchersTable\.branchId, bid\)/);
  assert.doesNotMatch(helper, /purchaseInvoicesTable\.branchId/);
});

test("both supplier statement routes include ranged rows and prior-date opening allocations", async () => {
  const source = await readFile(new URL("../src/routes/purchases-analytics.ts", import.meta.url), "utf8");
  const statementStart = source.indexOf('router.get("/supplier-statement"');
  const detailedStart = source.indexOf('router.get("/supplier-statement-detailed"');
  const statement = source.slice(statementStart, detailedStart);
  const detailed = source.slice(detailedStart, source.indexOf('router.get("/aging"', detailedStart));

  for (const route of [statement, detailed]) {
    assert.match(route, /supplierInvoiceLinkedVoucherTotals\([\s\S]*lt\(paymentVouchersTable\.date, date\)/);
    assert.match(route, /supplierInvoiceLinkedVoucherRows\(cid, req, bid/);
    assert.match(route, /gte\(paymentVouchersTable\.date, from\)/);
    assert.match(route, /lte\(paymentVouchersTable\.date, to\)/);
    assert.match(route, /supplierId === sid/);
    assert.match(route, /debit: p\.allocatedAmount/);
    assert.match(route, /a\.date\.localeCompare\(b\.date\)[\s\S]*a\.type\.localeCompare\(b\.type\)/);
  }
  assert.match(statement, /journalEntryNumber: p\.journalEntryNumber/);
  assert.match(statement, /voucherDesc\(p\.description, p\.notes\)/);
  assert.match(detailed, /meta:\s*\{[\s\S]*cashBoxName:[\s\S]*bankAccountName:[\s\S]*refNumber:[\s\S]*description:/);
});

test("row loader applies voucher guards and invoice eligibility without invoice branch scope", async () => {
  const source = await readFile(new URL("../src/routes/purchases-analytics.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function supplierInvoiceLinkedVoucherRows");
  const end = source.indexOf("\n/**", start);
  const helper = source.slice(start, end);
  assert.match(helper, /eq\(paymentVouchersTable\.companyId, cid\)/);
  assert.match(helper, /eq\(paymentVouchersTable\.status, "posted"\)/);
  assert.match(helper, /isNull\(paymentVouchersTable\.entityId\)/);
  assert.match(helper, /branchScopeSpread\(req, paymentVouchersTable\.branchId, bid\)/);
  assert.match(helper, /eq\(purchaseInvoicesTable\.companyId, cid\)/);
  assert.match(helper, /eq\(purchaseInvoicesTable\.status, "posted"\)/);
  assert.match(helper, /eq\(purchaseInvoicesTable\.paymentType, "credit"\)/);
  assert.match(helper, /purchaseInvoicesTable\.lcId/);
  assert.doesNotMatch(helper, /purchaseInvoicesTable\.branchId/);
});

test("both customer statement routes include ranged rows and prior-date opening allocations", async () => {
  const source = await readFile(new URL("../src/routes/sales-analytics.ts", import.meta.url), "utf8");
  const statementStart = source.indexOf('router.get("/customer-statement"');
  const detailedStart = source.indexOf('router.get("/customer-statement-detailed"');
  const statement = source.slice(statementStart, detailedStart);
  const detailed = source.slice(detailedStart, source.indexOf('router.get("/aging"', detailedStart));

  for (const route of [statement, detailed]) {
    assert.match(route, /customerInvoiceLinkedVoucherTotals\(/);
    assert.match(route, /receiptVouchersTable\.date} < \$\{date\}/);
    assert.match(route, /customerInvoiceLinkedVoucherRows\(cid, req, bid/);
    assert.match(route, /gte\(receiptVouchersTable\.date, from\)/);
    assert.match(route, /lte\(receiptVouchersTable\.date, to\)/);
    assert.match(route, /customerId === ccid/);
    assert.match(route, /credit: r\.allocatedAmount/);
  }
  assert.match(statement, /voucherDesc\(r\.description, r\.notes\)/);
  assert.match(detailed, /journalEntryNumber: r\.journalEntryNumber/);
  assert.match(detailed, /meta:\s*\{[\s\S]*cashBoxName:[\s\S]*bankAccountName:[\s\S]*refNumber:[\s\S]*description:/);
});

test("customer row loader uses voucher scope and posted credit invoice eligibility", async () => {
  const source = await readFile(new URL("../src/routes/sales-analytics.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function customerInvoiceLinkedVoucherRows");
  const end = source.indexOf("\n/**", start);
  const helper = source.slice(start, end);
  assert.match(helper, /eq\(receiptVouchersTable\.companyId, cid\)/);
  assert.match(helper, /eq\(receiptVouchersTable\.status, "posted"\)/);
  assert.match(helper, /isNull\(receiptVouchersTable\.entityId\)/);
  assert.match(helper, /branchScopeSpread\(req, receiptVouchersTable\.branchId, bid\)/);
  assert.match(helper, /eq\(salesInvoicesTable\.companyId, cid\)/);
  assert.match(helper, /eq\(salesInvoicesTable\.status, "posted"\)/);
  assert.match(helper, /eq\(salesInvoicesTable\.paymentType, "credit"\)/);
  assert.doesNotMatch(helper, /salesInvoicesTable\.branchId/);
});