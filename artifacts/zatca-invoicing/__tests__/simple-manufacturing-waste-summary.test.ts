import assert from "node:assert/strict";
import test from "node:test";

import {
  additionalHeaderWaste,
  stageWasteSummary,
} from "../src/pages/simple-manufacturing/wasteSummary";

test("compact waste summary converts completed normal/abnormal stages once", () => {
  const summary = stageWasteSummary([
    { status: "done", wasteQty: 4, wasteUnitFactor: 0.25, wasteClassification: "normal" },
    { status: "completed", wasteQty: 1, wasteUnitFactor: 2, wasteClassification: "abnormal" },
    // A saved draft is history, not close evidence yet.
    { status: "in_progress", wasteQty: 12, wasteUnitFactor: 1, wasteClassification: "normal" },
    { status: "skipped", wasteQty: 3, wasteUnitFactor: 1, wasteClassification: "normal" },
  ]);

  assert.deepEqual(summary, { total: 3, normal: 1, abnormal: 2 });
});

test("additional header waste is explicit and never planned-minus-actual", () => {
  const stages = [
    { status: "done", wasteQty: 1, wasteUnitFactor: 1, wasteClassification: "normal" },
  ];

  assert.equal(additionalHeaderWaste(4, stages), 3);
  assert.equal(additionalHeaderWaste(0, stages), 0);
  // A partial output of 99 from a planned 100 does not create inferred waste.
  assert.equal(additionalHeaderWaste(0, [
    { status: "done", wasteQty: 0, wasteUnitFactor: 1, wasteClassification: "normal" },
  ]), 0);
});