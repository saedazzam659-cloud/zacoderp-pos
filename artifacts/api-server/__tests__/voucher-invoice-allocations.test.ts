import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeVoucherInvoiceAllocations } from "../src/lib/voucher-invoice-allocations.js";

test("missing allocations preserve the legacy invoice-link path", () => {
  assert.equal(normalizeVoucherInvoiceAllocations(undefined, "10.00"), null);
});

test("an empty allocation list explicitly clears links", () => {
  assert.deepEqual(normalizeVoucherInvoiceAllocations([], "10.00"), []);
});

test("allocates voucher value proportionally and preserves every cent", () => {
  const rows = normalizeVoucherInvoiceAllocations([
    { invoiceId: 10, percentage: 33.33 },
    { invoiceId: 11, percentage: 33.33 },
    { invoiceId: 12, percentage: 33.34 },
  ], "10.00");

  assert.deepEqual(rows?.map((row) => row.amount), ["3.33", "3.33", "3.34"]);
  assert.equal(rows?.reduce((sum, row) => sum + Number(row.amount), 0), 10);
});

test("allocates indivisible cents without changing the voucher total", () => {
  const rows = normalizeVoucherInvoiceAllocations([
    { invoiceId: 1, percentage: 50 },
    { invoiceId: 2, percentage: 50 },
  ], "0.03");

  assert.deepEqual(rows?.map((row) => row.amount), ["0.02", "0.01"]);
});

test("rejects duplicate invoices, incomplete percentages, and zero-cent shares", () => {
  assert.throws(() => normalizeVoucherInvoiceAllocations([
    { invoiceId: 1, percentage: 50 },
    { invoiceId: 1, percentage: 50 },
  ], "10.00"), /أكثر من مرة/);

  assert.throws(() => normalizeVoucherInvoiceAllocations([
    { invoiceId: 1, percentage: 40 },
    { invoiceId: 2, percentage: 40 },
  ], "10.00"), /100٪/);

  assert.throws(() => normalizeVoucherInvoiceAllocations([
    { invoiceId: 1, percentage: 99.99 },
    { invoiceId: 2, percentage: 0.01 },
  ], "1.00"), /0.01/);
});
