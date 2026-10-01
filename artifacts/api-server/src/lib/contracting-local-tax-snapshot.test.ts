import test from "node:test";
import assert from "node:assert/strict";
import { resolveOwnerBillLineTaxSnapshots } from "./contracting-local-tax-snapshot.js";

const bill = {
  grossAmount: "100.00",
  previousPaid: "0.00",
  retentionAmount: "5.00",
  dueAmount: "95.00",
  vatPercent: "14.00",
  vatAmount: "14.00",
  netAmount: "109.00",
};

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    boqLineId: 10,
    unitSnapshot: "EA",
    currentValue: "100.00",
    quotedVatPercentSnapshot: "14.00",
    quotedPriceComponentsSnapshot: null,
    ...overrides,
  };
}

test("snapshots a simple linked Egyptian bill line when the stored totals reconcile", () => {
  const result = resolveOwnerBillLineTaxSnapshots({
    countryCode: "EG",
    currencyCode: "EGP",
    bill,
    lines: [line()],
  });
  assert.deepEqual(result[0], {
    lineId: 1,
    snapshot: {
      version: 1,
      countryCode: "EG",
      currencyCode: "EGP",
      taxBase: "100.00",
      taxRatePercent: "14.00",
      taxAmount: "14.00",
    },
    error: null,
  });
});

test("leaves legacy, multi-component, and mismatched-rate lines unresolved", () => {
  const result = resolveOwnerBillLineTaxSnapshots({
    countryCode: "EG",
    currencyCode: "EGP",
    bill,
    lines: [
      line({ id: 1, boqLineId: null }),
      line({ id: 2, quotedPriceComponentsSnapshot: [
        { unitPrice: "50.00", vatPercent: "14.00", priceIncludesVat: false },
        { unitPrice: "50.00", vatPercent: "14.00", priceIncludesVat: false },
      ] }),
      line({ id: 3, quotedVatPercentSnapshot: "10.00" }),
    ],
  });
  assert.equal(result[0].snapshot, null);
  assert.match(result[0].error ?? "", /BOQ/);
  assert.equal(result[1].snapshot, null);
  assert.match(result[1].error ?? "", /مكونات/);
  assert.equal(result[2].snapshot, null);
  assert.match(result[2].error ?? "", /لا تطابق/);
});

test("does not distribute a bill-level VAT mismatch across lines", () => {
  const result = resolveOwnerBillLineTaxSnapshots({
    countryCode: "EG",
    currencyCode: "EGP",
    bill: { ...bill, vatAmount: "13.99" },
    lines: [line()],
  });
  assert.equal(result[0].snapshot, null);
  assert.match(result[0].error ?? "", /لا تتطابق/);
});

test("reconciles the full invoice total without treating retention as a taxable discount", () => {
  const result = resolveOwnerBillLineTaxSnapshots({
    countryCode: "EG",
    currencyCode: "EGP",
    bill: { ...bill, retentionAmount: "4.99" },
    lines: [line()],
  });
  assert.equal(result[0].snapshot, null);
  assert.match(result[0].error ?? "", /لا تتطابق/);
});

test("does not assign a local currency to legacy projects", () => {
  const result = resolveOwnerBillLineTaxSnapshots({
    countryCode: "JO",
    currencyCode: null,
    bill,
    lines: [line()],
  });
  assert.equal(result[0].snapshot, null);
  assert.match(result[0].error ?? "", /عملة/);
});