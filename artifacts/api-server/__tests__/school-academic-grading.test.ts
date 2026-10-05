import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateWeightedPercentage,
  gradeLabel,
  resultStatus,
  validateWeights,
} from "../src/lib/schoolAcademicGrading.js";

test("calculates weighted percentages and rounds to two decimals", () => {
  assert.deepEqual(
    calculateWeightedPercentage(
      { coursework: 30, monthly: 70 },
      { coursework: 87.29, monthly: 71.13 },
    ),
    { complete: true, percentage: 75.98, missing: [] },
  );
});

test("blocks approval when a weighted component is missing, but ignores zero-weight parts", () => {
  assert.deepEqual(
    calculateWeightedPercentage(
      { coursework: 100, monthly: 0 },
      { coursework: 92 },
    ),
    { complete: true, percentage: 92, missing: [] },
  );
  assert.deepEqual(
    calculateWeightedPercentage(
      { coursework: 70, monthly: 30 },
      { coursework: 92 },
    ),
    { complete: false, percentage: null, missing: ["monthly"] },
  );
});

test("validates allowed components and requires a 100 percent weight total", () => {
  const allowed = new Set(["coursework", "monthly"]);
  assert.equal(validateWeights({ coursework: 70, monthly: 30 }, allowed), true);
  assert.equal(validateWeights({ coursework: 70, monthly: 20 }, allowed), false);
  assert.equal(validateWeights({ coursework: 100, final: 0 }, allowed), false);
});

test("applies configurable grade bands and distinguishes second-round eligibility", () => {
  assert.equal(gradeLabel(85, [
    { minimumPercent: 70, label: "جيد" },
    { minimumPercent: 90, label: "ممتاز" },
    { minimumPercent: 80, label: "جيد جداً" },
  ]), "جيد جداً");
  assert.equal(resultStatus(35, 50, 0), "fail");
  assert.equal(resultStatus(45, 50, 40), "second_round");
  assert.equal(resultStatus(50, 50, 40), "pass");
});
