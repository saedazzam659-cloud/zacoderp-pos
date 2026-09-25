import test from "node:test";
import assert from "node:assert/strict";
import { executionEstimate, type ExecutionLine } from "../src/lib/contractingExecution";

const base: ExecutionLine = {
  boqLineId: 1, previousQty: "0", previousValue: "0", currentQty: "0", currentValue: "0",
  unitPriceSnapshot: "86.96", quotedUnitPriceSnapshot: "100.00",
  quotedVatPercentSnapshot: "15.00", quotedPriceIncludesVatSnapshot: true,
  quotedPriceComponentsSnapshot: [{ unitPrice: "100.00", vatPercent: "15.00", priceIncludesVat: true }],
};
const input = (qty: string, percent = "100", release = "0") => ({
  currentQty: qty, certificationPercent: percent, priorPendingCertifiedValue: release,
  certificationReason: "اعتماد جزئي",
});

test("inclusive BOQ preview extracts VAT on extended quote and reconciles partial certification", () => {
  assert.equal(executionEstimate(base, input("1000")).executionValue, 86956.52);
  const first = executionEstimate(base, input("333", "80"));
  const later = executionEstimate({
    ...base, previousQty: "333", previousPendingValue: String(first.pending),
    priorExecutionValue: String(first.executionValue), cumulativeQuoteCompatible: true,
  }, input("667", "100", String(first.pending)));
  assert.equal(first.executionValue, 28956.52);
  assert.equal(later.executionValue, 58000);
  assert.equal(Math.round((first.certifiedTotal + later.certifiedTotal) * 100), 8695652);
});

test("preview extends each change-order quotation at its own VAT rate", () => {
  const mixed: ExecutionLine = {
    ...base, unitPriceSnapshot: "106.01", quotedUnitPriceSnapshot: null,
    quotedPriceIncludesVatSnapshot: false,
    quotedPriceComponentsSnapshot: [
      { unitPrice: "100.00", vatPercent: "15.00", priceIncludesVat: true },
      { unitPrice: "20.00", vatPercent: "5.00", priceIncludesVat: true },
    ],
  };
  assert.equal(executionEstimate(mixed, input("1000")).executionValue, 106004.14);
  assert.equal(executionEstimate({
    ...mixed, quotedPriceComponentsSnapshot: [
      mixed.quotedPriceComponentsSnapshot![0],
      { unitPrice: "-10.00", vatPercent: "5.00", priceIncludesVat: true },
    ],
  }, input("1000")).executionValue, 77432.71);
});