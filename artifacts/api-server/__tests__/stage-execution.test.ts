import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  nextStageInputQuantity,
  normalizeStageExecutionPayload,
  restrictStageExecutionPayload,
  resolvedStageInputQuantity,
  stageWasteTotals,
} from "../src/lib/stageExecution.ts";

test("execution-only stage payload keeps operational facts and strips route configuration", () => {
  const restricted = restrictStageExecutionPayload({
    inputQty: 100,
    outputQty: 96,
    wasteQty: 4,
    actualDurationMinutes: 90,
    workerCount: 3,
    wasteReason: "حرارة",
    wasteType: "quality",
    wasteClassification: "abnormal",
    resourceId: 22,
    resourceMode: "machine",
    workerEmployeeIds: [7, 9],
    workCenterId: 4,
    quantityUnit: "box",
    notes: "must not be editable",
    status: "done",
  });

  assert.deepEqual(restricted, {
    inputQty: 100,
    outputQty: 96,
    wasteQty: 4,
    actualDurationMinutes: 90,
    workerCount: 3,
    wasteReason: "حرارة",
    wasteType: "quality",
    wasteClassification: "abnormal",
  });
  assert.throws(
    () => normalizeStageExecutionPayload(restrictStageExecutionPayload({ costAmount: 100 })),
    /محرك تكلفة فقط/,
  );
});

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
    /مستخدم النظام/,
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
    normalizeStageExecutionPayload({ resourceMode: "both", resourceId: "12", workerCount: 2 }),
    { resourceMode: "both", resourceId: 12, workerCount: 2 },
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
  assert.deepEqual(
    normalizeStageExecutionPayload({ workerEmployeeId: "7" }),
    { operatorEmployeeId: 7 },
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ workerEmployeeId: "bad" }),
    /موظف الموارد البشرية/,
  );
  assert.deepEqual(
    normalizeStageExecutionPayload({ workerEmployeeIds: ["7", 9, "7"] }),
    { workerEmployeeIds: [7, 9], operatorEmployeeId: 7 },
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ workerEmployeeIds: [7, "bad"] }),
    /موظف الموارد البشرية/,
  );
});

test("stage units validate explicit factors and convert output/waste once", () => {
  assert.deepEqual(
    normalizeStageExecutionPayload({
      quantityUnit: "KG",
      quantityUnitFactor: "0.25",
      wasteUnit: "BAG",
      wasteUnitFactor: 2,
    }),
    {
      quantityUnit: "KG",
      quantityUnitFactor: 0.25,
      wasteUnit: "BAG",
      wasteUnitFactor: 2,
    },
  );
  assert.equal(nextStageInputQuantity(8, 0.25, 1), 2);
  assert.deepEqual(
    stageWasteTotals([
      { wasteQty: 4, wasteUnit: "KG", wasteUnitFactor: 0.25, wasteClassification: "normal" },
      { wasteQty: 1, wasteUnit: "BAG", wasteUnitFactor: 2, wasteClassification: "abnormal" },
      { wasteQty: 1, wasteUnitFactor: 1, wasteClassification: null },
    ]),
    { total: 4, normal: 1, abnormal: 3 },
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ quantityUnitFactor: 0 }),
    /عامل وحدة الكمية/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ wasteUnitFactor: "NaN" }),
    /عامل وحدة الهالك/,
  );
  assert.throws(
    () => normalizeStageExecutionPayload({ quantityUnit: null, quantityUnitFactor: 2 }),
    /يساوي 1 عندما تكون الوحدة فارغة/,
  );
  assert.deepEqual(
    normalizeStageExecutionPayload({ wasteUnit: null }),
    { wasteUnit: null, wasteUnitFactor: 1 },
  );
  assert.equal(resolvedStageInputQuantity("0", 100, true), 100);
  assert.equal(resolvedStageInputQuantity("0", 100, false), 0);
  assert.equal(resolvedStageInputQuantity("12", 100, false), 12);
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
  assert.match(production, /productionExecutionRouter\.post\("\/orders\/:id\/stages\/:stageId\/reopen"/);
  assert.match(production, /resolvedStageInputQuantity/);
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
  assert.match(production, /pg_advisory_xact_lock\(\$\{ctx\.cid\}, \$\{ctx\.order\.id\}\)/);
  assert.match(production, /eq\(productionOrderStagesTable\.status, "in_progress"\)/);
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

test("stage execution exposes assigned raw materials and posted issue status", async () => {
  const [production, executionUi] = await Promise.all([
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../../zatca-invoicing/src/components/ProductionStageExecution.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(production, /productionOrderItemsTable\.kind, "raw"/);
  assert.match(production, /stage_material_issue_posted/);
  assert.match(production, /materials: stageMaterials/);
  assert.match(executionUi, /خامات هذه المرحلة/);
  assert.match(executionUi, /الكمية المخططة/);
  assert.match(executionUi, /هالك الخامة/);
  assert.match(executionUi, /materialWasteLines/);
  assert.match(executionUi, /المصروف من المخزون/);
  assert.match(executionUi, /سيُصرف عند إنهاء المرحلة/);
  assert.match(production, /stageMaterialWasteQty/);
  assert.match(production, /plannedQty \+ waste\.quantity/);
  assert.match(production, /materialIssueLines: issueLines/);
  assert.match(production, /سبق تسجيل صرف خامات لهذه المرحلة/);
  assert.match(production, /accountId: order\.wipAccountId, debit: amount/);
});

test("routing material defaults seed a new order while order-level choices remain editable", async () => {
  const [setup, orderRoute, wizard] = await Promise.all([
    readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../../zatca-invoicing/src/pages/simple-manufacturing/SimpleWizard.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(setup, /materialLineIds: Array\.isArray\(x\.materialLineIds\)/);
  assert.match(setup, /materialLineIds: x\.materialLineIds/);
  assert.match(orderRoute, /configuredStageByBomLine\.get\(Number\(line\.id\)\)/);
  assert.match(wizard, /defaults\.get\(Number\(line\.id\)\)/);
  assert.match(wizard, /setMaterialStageAssignments/);
});

test("generic stage PATCH cannot bypass completion postings by changing status", async () => {
  const production = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const patchStart = production.indexOf(
    'productionExecutionRouter.patch("/orders/:id/stages/:stageId"',
  );
  const reopenStart = production.indexOf(
    'productionExecutionRouter.post("/orders/:id/stages/:stageId/reopen"',
    patchStart,
  );
  assert.ok(patchStart >= 0 && reopenStart > patchStart, "expected stage PATCH and reopen routes");

  const patchRoute = production.slice(patchStart, reopenStart);
  assert.match(patchRoute, /hasOwnProperty\.call\(rawBody,\s*"status"\)/);
  assert.match(patchRoute, /res\.status\(400\)\.json/);
  assert.doesNotMatch(patchRoute, /updates\.status\s*=/);
});