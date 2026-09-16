import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateSignedContractingBillNet,
  exactCents,
  formatExactCents,
  sumExactCents,
} from "../src/lib/contracting-bill-adjustment-math.js";

test("signed contracting net applies additions, ordinary deductions, and penalties once", () => {
  const result = calculateSignedContractingBillNet({
    rawNetAmount: "1000.00",
    additions: [{ amount: "10.10" }, { amount: "0.20" }],
    deductions: [
      { kind: "materials", amount: "5.15" },
      { kind: "retention", amount: "100.00" },
      { kind: "advance", amount: "40.00" },
      { kind: "settlement", amount: "25.00" },
    ],
    penalties: [{ amount: "2.05" }],
  });

  assert.equal(result.additionsTotal, "10.30");
  assert.equal(result.generalDeductionsTotal, "5.15");
  assert.equal(result.penaltiesTotal, "2.05");
  assert.equal(result.signedAdjustmentAmount, "3.10");
  assert.equal(result.adjustedNetAmount, "1003.10");
});

test("exact cents avoids binary floating-point drift and formats signed values", () => {
  assert.equal(exactCents("0.10") + exactCents("0.20"), 30n);
  assert.equal(sumExactCents(["0.10", "0.20", "0.30"]), "0.60");
  assert.equal(formatExactCents(exactCents("1.005")), "1.01");
  assert.equal(formatExactCents(exactCents("-2.50")), "-2.50");
});

test("negative signed settlement is clamped only at the adjusted net boundary", () => {
  const result = calculateSignedContractingBillNet({
    rawNetAmount: "5.00",
    additions: [],
    deductions: [{ kind: "other", amount: "8.00" }],
    penalties: [],
  });
  assert.equal(result.signedAdjustmentAmount, "-8.00");
  assert.equal(result.unclampedNetAmount, "-3.00");
  assert.equal(result.adjustedNetAmount, "0.00");
});