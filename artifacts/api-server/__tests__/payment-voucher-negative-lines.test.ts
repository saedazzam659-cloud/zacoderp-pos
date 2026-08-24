import test from "node:test";
import assert from "node:assert/strict";
import {
  paymentVoucherAccountingTotal,
  paymentVoucherLineAccounting,
} from "../src/lib/paymentVoucherLineAccounting";

test("payment voucher positive allocation becomes a debit", () => {
  assert.deepEqual(paymentVoucherLineAccounting({
      amount: 1_000,
      taxAmount: 150,
      opType: "direct",
  }), {
    debit: 1_000,
    credit: 0,
    taxDebit: 150,
    total: 1_150,
  });
});

test("payment voucher negative direct allocation becomes a credit and reduces cash paid", () => {
  assert.deepEqual(paymentVoucherLineAccounting({
      amount: -200,
      taxAmount: 0,
      opType: "direct",
  }), {
    debit: 0,
    credit: 200,
    taxDebit: 0,
    total: -200,
  });

  assert.equal(paymentVoucherAccountingTotal([
    { amount: 1_000, taxAmount: 0, opType: "direct" },
    { amount: -200, taxAmount: 0, opType: "direct" },
  ]), 800);
});

test("payment voucher rejects tax, invoice settlement, and special operations on negative lines", () => {
  assert.throws(() => paymentVoucherLineAccounting({
    amount: -100,
    taxAmount: 15,
    opType: "direct",
  }), /البند السالب لا يقبل ضريبة/);

  assert.throws(() => paymentVoucherLineAccounting({
    amount: -100,
    taxAmount: 0,
    opType: "direct",
    purchaseInvoiceId: 12,
  }), /لا يمكن ربط بند سالب بفاتورة مورد/);

  assert.throws(() => paymentVoucherLineAccounting({
    amount: -100,
    taxAmount: 0,
    opType: "employee_loan",
  }), /لا يمكن أن يكون بند العملية الخاصة بالسالب/);
});