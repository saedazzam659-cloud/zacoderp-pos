import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  aggregateProjectReportRollup,
  buildBoqPricingProfitability,
  buildHistoricalOwnerPriceReferences,
  buildHistoricalOwnerPriceReportRows,
} from "../src/lib/contracting-project-reports-service.ts";

function report(revenue: number, cost: number, billId: number) {
  const side = {
    baseContractValue: revenue,
    approvedVariationsValue: 0,
    adjustedContractValue: revenue,
    executedValue: revenue,
    remainingValue: 0,
    billCount: 1,
    certifiedBillCount: 1,
    actualPaid: revenue,
    due: 0,
    advanceActual: 0,
    advanceRecovered: 0,
    advanceRemaining: 0,
    retention: 0,
  };
  return {
    dashboard: {
      ...side,
      state: "in_progress",
      ownerRevenue: side,
      subcontractCost: { ...side, baseContractValue: cost, adjustedContractValue: cost, executedValue: cost },
      latestBill: { id: billId, billDate: `2025-01-0${billId}` },
    },
    reports: {
      boqStatement: [{ id: billId }],
      executedQuantities: [],
      bills: [{ id: billId }],
      cumulative: [],
      advance: [],
      retention: [],
      deductions: [],
      variations: [],
      pricingProfitability: [],
      profitability: { revenue, actualCost: cost, costAvailable: true },
    },
    limitations: [],
    completeness: { certifiedBillCount: 1, unmappedCertifiedLineCount: 0 },
  };
}

test("recursive rollup includes each level exactly once while local report stays isolated", () => {
  const local = report(100, 40, 1);
  const child = report(50, 20, 2);
  const grandchild = report(25, 10, 3);
  const rolled = aggregateProjectReportRollup([
    { projectId: 1, report: local },
    { projectId: 2, report: child },
    { projectId: 3, report: grandchild },
  ]);

  assert.equal(local.dashboard.ownerRevenue.executedValue, 100);
  assert.equal(rolled.dashboard.ownerRevenue.executedValue, 175);
  assert.equal(rolled.dashboard.certifiedBillCount, 3);
  assert.deepEqual(rolled.reports.bills.map((row: any) => row.projectId), [1, 2, 3]);
  assert.equal(rolled.reports.profitability.profit, 105);
  assert.equal(rolled.reports.profitability.marginPercent, 60);
});

test("BOQ mapping preserves independent owner/subcontract prices and derives profit", () => {
  const mapped = buildBoqPricingProfitability([
    { id: 10, direction: "owner", totalAmount: "1000" },
    { id: 20, direction: "subcontract", sourceOwnerLineId: 10, totalAmount: "300" },
    { id: 21, direction: "subcontract", sourceOwnerLineId: 10, totalAmount: "250" },
    { id: 22, direction: "subcontract", sourceOwnerLineId: null, totalAmount: "999" },
  ]);
  assert.deepEqual(mapped, [{
    ownerBoqLineId: 10,
    mappedSubcontractLineIds: [20, 21],
    expectedRevenue: 1000,
    expectedMappedCost: 550,
    expectedProfit: 450,
    expectedMarginPercent: 45,
  }]);
});

test("historical owner BOQ prices use exact normalized description and unit, exclude hidden or invalid sources, and calculate odd/even medians", () => {
  const targets = [
    { id: 7, code: "W-7", nameAr: "Concrete pour", description: "  Concrete   Pour ", unit: "M3" },
    { id: 8, code: null, nameAr: "Different target", description: "Other work", unit: "m2" },
  ];
  const row = (sourceLineId: number, overrides: Record<string, unknown> = {}) => ({
    companyId: 4,
    sourceLineId,
    projectId: 100 + sourceLineId,
    branchId: 2,
    projectCode: `P-${sourceLineId}`,
    projectName: `Project ${sourceLineId}`,
    direction: "owner",
    description: " concrete pour ",
    unit: "m3",
    unitPrice: sourceLineId,
    contractStatus: "approved",
    contractNumber: `C-${sourceLineId}`,
    contractDate: `2025-01-${String(sourceLineId).padStart(2, "0")}`,
    contractType: "main",
    ...overrides,
  });
  const references = buildHistoricalOwnerPriceReferences(4, 1, targets, [
    row(1, { unitPrice: 10, projectId: 1 }), // target project is never its own reference
    row(2, { unitPrice: 10 }),
    row(3, { unitPrice: 20 }),
    row(4, { unitPrice: 30 }),
    row(5, { unitPrice: 40 }),
    row(6, { unitPrice: 50 }),
    row(7, { unitPrice: 999, projectId: 107, workItemId: 7, description: "Concrete pour changed" }),
    row(8, { unitPrice: 999, projectId: 108, unit: "m2" }),
    row(9, { unitPrice: 999, projectId: 109, contractStatus: "draft" }),
    row(10, { unitPrice: 0 }),
    row(11, { unitPrice: 999, direction: "subcontract" }),
    row(12, { companyId: 99, unitPrice: 999 }),
    row(13, { branchId: 9, unitPrice: 999 }),
  ], branchId => branchId === 2);

  assert.equal(references[0].comparableCount, 5);
  assert.equal(references[0].medianUnitPrice, 30);
  assert.deepEqual(references[0].medianSources.map(source => source.unitPrice), [30]);
  assert.equal(references[0].latest?.contractNumber, "C-6");
  assert.deepEqual(references[0].recentSources.map(source => source.contractNumber), ["C-6", "C-5", "C-4", "C-3", "C-2"]);

  const evenReferences = buildHistoricalOwnerPriceReferences(4, 1, [targets[0]], [
    row(20, { unitPrice: 5, contractDate: "2024-01-01" }),
    row(21, { unitPrice: 15, contractDate: "2024-01-02" }),
    row(22, { unitPrice: 25, contractDate: "2024-01-03" }),
    row(23, { unitPrice: 35, contractDate: "2024-01-04" }),
  ], () => true);
  assert.equal(evenReferences[0].medianUnitPrice, 20);
  assert.deepEqual(evenReferences[0].medianSources.map(source => source.unitPrice), [15, 25]);

  const reportRows = buildHistoricalOwnerPriceReportRows(references);
  assert.deepEqual(Object.keys(reportRows[0]), [
    "itemCode", "itemName", "unit", "medianUnitPrice", "comparableCount", "latestUnitPrice",
    "latestContractNumber", "latestContractDate", "latestProjectCode", "latestProjectName",
    "medianSourceReferences",
  ]);
  assert.match(reportRows[0].medianSourceReferences, /30\.00 — C-4 \(P-4\)/);
});

test("historical owner price report rows are retained per project in report rollups", () => {
  const first = report(100, 40, 1);
  const second = report(50, 20, 2);
  first.reports.historicalOwnerPrices = [{ itemCode: "A", itemName: "Work A" }];
  second.reports.historicalOwnerPrices = [{ itemCode: "A", itemName: "Work A" }];
  const rolled = aggregateProjectReportRollup([
    { projectId: 1, report: first },
    { projectId: 2, report: second },
  ]);
  assert.deepEqual(rolled.reports.historicalOwnerPrices.map((row: any) => row.projectId), [1, 2]);
});

test("report route keeps local mode as the default and recursive SQL is tenant, branch, and cycle scoped", () => {
  const route = readFileSync(new URL("../src/routes/contracting-project-reports.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/lib/contracting-project-reports-service.ts", import.meta.url), "utf8");
  assert.match(route, /includeDescendants:\s*rawIncludeDescendants === "true"/);
  assert.match(service, /if \(!options\.includeDescendants\) return local/);
  assert.match(service, /child\.company_id = \$\{companyId\}/);
  assert.match(service, /child\.branch_id IN/);
  assert.match(service, /NOT child\.id = ANY\(tree\.path\)/);
});