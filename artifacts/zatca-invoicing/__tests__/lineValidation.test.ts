import assert from "node:assert/strict";
import test from "node:test";
import { validateInvoiceLines } from "../src/lib/lineValidation";

const serviceLine = {
  itemId: "17",
  itemName: "خدمة",
  unitId: "3",
  unit: "خدمة",
  qty: "1",
  unitPrice: "0",
};

test("zero-priced service lines remain blocked unless explicitly enabled", () => {
  assert.equal(validateInvoiceLines([serviceLine]).ok, false);
  assert.equal(validateInvoiceLines([serviceLine], {
    allowZeroPriceItemIds: new Set([17]),
  }).ok, true);
});

test("the zero-price exception applies only to explicitly allowed item IDs", () => {
  assert.equal(validateInvoiceLines([serviceLine], {
    allowZeroPriceItemIds: new Set([18]),
  }).ok, false);
});

test("the zero-price exception does not accept a blank price", () => {
  assert.equal(validateInvoiceLines([{ ...serviceLine, unitPrice: "" }], {
    allowZeroPriceItemIds: new Set([17]),
  }).ok, false);
});
