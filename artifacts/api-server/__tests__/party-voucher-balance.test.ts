import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { supplementalInvoiceLinkedVoucherTotals } from "../src/lib/partyVoucherBalance.js";

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