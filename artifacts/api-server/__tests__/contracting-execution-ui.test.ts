import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executionEstimate, executionInput, executionInputs, executionPayload, executionValidation,
  type ExecutionLine,
} from "../../zatca-invoicing/src/lib/contractingExecution.ts";

const row: ExecutionLine = {
  boqLineId: 4, workItemName: "خرسانة", contractQty: "100", previousQty: "0",
  currentQty: "50", previousValue: "0", currentValue: "40000",
  unitPriceSnapshot: "1000", certificationPercent: "80", previousPendingValue: "0",
  certificationReason: "محضر الاستشاري",
};
test("UI presents 50 executed / 80 percent as 40000 certified, 10000 pending, 50 remaining", () => {
  const view = executionEstimate(row, executionInput(row));
  assert.equal(view.cumulativeQty, 50);
  assert.equal(view.remainingQty, 50);
  assert.equal(view.certifiedTotal, 40000);
  assert.equal(view.pending, 10000);
});
test("UI later pending-only approval does not add physical execution", () => {
  const next = { ...row, previousQty: "50", currentQty: "0", certificationPercent: "100",
    previousPendingValue: "10000", priorPendingCertifiedValue: "10000" };
  const view = executionEstimate(next, executionInput(next));
  assert.equal(view.cumulativeQty, 50);
  assert.equal(view.remainingQty, 50);
  assert.equal(view.certifiedTotal, 10000);
  assert.equal(view.pending, 0);
  assert.equal(executionValidation([next], executionInputs([next])), null);
});
test("UI guards quantity, percentage, release amount and required reference", () => {
  for (const invalid of [
    { currentQty: "101" }, { certificationPercent: "101" },
    { priorPendingCertifiedValue: "1" }, { certificationReason: "" },
  ]) {
    const input = { ...executionInput(row), ...invalid };
    assert.ok(executionValidation([row], { 4: input }));
  }
});
test("batch payload includes certification controls and only explicitly linked BOQ lines", () => {
  const rows = [row, { ...row, id: 8, boqLineId: null }];
  const payload = executionPayload(rows, executionInputs(rows));
  assert.equal(payload.length, 1);
  assert.equal(payload[0].currentQty, "50");
  assert.equal(payload[0].certificationPercent, "80");
  assert.equal(payload[0].priorPendingCertifiedValue, "0");
  assert.equal(payload[0].certificationReason, "محضر الاستشاري");
});
test("legacy value without price snapshot is displayed as fully certified", () => {
  const legacy = { ...row, unitPriceSnapshot: null, certificationPercent: null, currentValue: "50000" };
  assert.equal(executionEstimate(legacy, executionInput(legacy)).certifiedTotal, 50000);
  assert.equal(executionEstimate(legacy, executionInput(legacy)).pending, 0);
});