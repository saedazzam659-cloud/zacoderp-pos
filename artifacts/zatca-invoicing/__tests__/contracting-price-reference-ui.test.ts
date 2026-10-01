import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("../src/components/ContractingContractBoqEditor.tsx", import.meta.url), "utf8");
const reports = readFileSync(new URL("../src/components/ContractingProjectReports.tsx", import.meta.url), "utf8");
const exports = readFileSync(new URL("../src/lib/contractingPrintExport.ts", import.meta.url), "utf8");

test("owner BOQ editor shows approved price references and applies them only by explicit choice", () => {
  assert.match(editor, /listHistoricalOwnerBoqPriceReferences\(projectId, \{ workItemId \}/);
  assert.match(editor, /direction !== "owner"/);
  assert.match(editor, /data-testid="owner-boq-price-reference"/);
  assert.match(editor, /استخدم آخر سعر/);
  assert.match(editor, /استخدم الوسيط/);

  const requestBlock = editor.slice(
    editor.indexOf("listHistoricalOwnerBoqPriceReferences("),
    editor.indexOf("const workItemOptions"),
  );
  assert.doesNotMatch(requestBlock, /setDraft/);
});

test("historical owner price references are selectable and included in branded report exports", () => {
  assert.match(reports, /value: "historicalOwnerPrices", label: "مرجع أسعار بنود المالك"/);
  assert.match(reports, /latestProjectName: "مشروع المصدر"/);
  assert.match(reports, /medianSourceReferences: "مصادر الوسيط"/);
  assert.match(exports, /historicalOwnerPrices: \[/);
  assert.match(exports, /latestContractNumber/);
  assert.match(exports, /medianSourceReferences/);
  assert.match(exports, /historicalOwnerPrices: "مرجع أسعار بنود المالك المعتمدة"/);
});