import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  normalizeStageExecutionPayload,
} from "../src/lib/stageExecution.ts";

test("stage execution normalizes aliases without creating a cost amount", async () => {
  const execution = normalizeStageExecutionPayload({
    inputQty: "100",
    outputQty: "96",
    wasteQty: "4",
    actualHours: "1.5",
    workerUserId: "12",
    machineId: "7",
    wasteReason: "  حرارة  ",
    wasteType: "quality",
    wasteClassification: "abnormal",
  }, { requireOutput: true });

  assert.deepEqual(execution, {
    inputQty: 100,
    outputQty: 96,
    wasteQty: 4,
    actualDurationMinutes: 90,
    operatorUserId: 12,
    resourceId: 7,
    wasteReason: "حرارة",
    wasteType: "quality",
    wasteClassification: "abnormal",
  });
  assert.equal("amount" in execution, false);
  assert.equal("cost" in execution, false);
  const helper = await readFile(new URL("../src/lib/stageExecution.ts", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /result\.(?:cost|amount)/);
});

test("stage execution rejects invalid duration, IDs, and unclassified waste", () => {
  assert.throws(
    () => normalizeStageExecutionPayload({ actualDurationMinutes: -1 }),
    /مدة التنفيذ/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ workerUserId: "other" }),
    /العامل/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ wasteClassification: "loss" }),
    /normal أو abnormal/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({}, { requireOutput: true }),
    /كمية الإخراج مطلوبة/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ costAmount: 100 }),
    /محرك تكلفة فقط/,
  );
});

test("stage execution normalizes an optional nonnegative worker count", () => {
  assert.deepEqual(
    normalizeStageExecutionPayload({ workerCount: "3" }),
    { workerCount: 3 },
  );
  assert.deepEqual(
    normalizeStageExecutionPayload({ workerCount: null }),
    { workerCount: null },
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ workerCount: 1.5 }),
    /عدد العمال/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ workerCount: -1 }),
    /عدد العمال/,
  );
});

test("compact facade mounts the shared execution and settlement engines", async () => {
  const [facade, production, schema] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../lib/db/src/schema/production.ts", import.meta.url), "utf8"),
  ]);

  assert.match(facade, /router\.use\(productionExecutionRouter\)/);
  assert.match(facade, /router\.use\(productionOverheadClosureRouter\)/);
  assert.doesNotMatch(facade, /router\.use\(productionRouter\)/);
  assert.match(facade, /requireModulePermission\("simple_manufacturing"\)/);
  assert.match(production, /export const productionExecutionRouter = Router\(\)/);
  assert.match(production, /export const productionOverheadClosureRouter = Router\(\)/);
  assert.match(production, /productionExecutionRouter\.post\("\/orders\/:id\/stages\/:stageId\/complete"/);
  assert.match(production, /productionOverheadClosureRouter\.post\("\/overhead-closures\/:id\/post"/);
  assert.match(production, /productionOverheadClosureRouter\.post\("\/overhead-closures\/:id\/reopen"/);
  assert.match(production, /reopenedJournalEntryId/);
  assert.match(production, /for \(const source of sourceRows\)/);
  assert.match(production, /getPostedIndustrialPurchaseCosts/);
  assert.match(production, /purchaseInvoicesTable\.journalEntryId/);
  assert.match(production, /purchaseReturnsTable\.journalEntryId/);
  assert.match(production, /reclassificationAccounts: \[\{[\s\S]*accountId: r\.sourceAccountId/);
  assert.match(production, /Payments and[\s\S]*not queried here/);
  assert.match(production, /Normal production loss[\s\S]*only abnormal loss is expensed/);
  assert.match(production, /refreshOrderActualHours/);
  assert.match(production, /sum\(production_order_stages\.actual_duration_minutes\)/);
  assert.match(production, /router\.get\("\/execution-catalog"/);
  assert.match(production, /validateExpenseAccount\(cid, varianceAccountId\)/);
  assert.match(production, /اختر فرعاً صراحةً لإغلاق نطاق فروع مقيّد/);
  assert.match(production, /ne\(productionOrderStagesTable\.status, "completed"\)/);
  assert.match(schema, /actualDurationMinutes: integer\("actual_duration_minutes"\)/);
  assert.match(schema, /workerCount: integer\("worker_count"\)/);
  assert.match(schema, /wasteClassification: text\("waste_classification"\)/);
  assert.match(facade, /router\.get\("\/execution-catalog", view/);
  assert.match(facade, /productionResourcesTable\.branchId/);
  assert.match(facade, /overhead-closures\/:id\/reopen/);
});