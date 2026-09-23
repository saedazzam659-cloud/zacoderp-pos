import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  aggregateProjectReportRollup,
  buildBoqPricingProfitability,
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

test("report route keeps local mode as the default and recursive SQL is tenant, branch, and cycle scoped", () => {
  const route = readFileSync(new URL("../src/routes/contracting-project-reports.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/lib/contracting-project-reports-service.ts", import.meta.url), "utf8");
  assert.match(route, /includeDescendants:\s*rawIncludeDescendants === "true"/);
  assert.match(service, /if \(!options\.includeDescendants\) return local/);
  assert.match(service, /child\.company_id = \$\{companyId\}/);
  assert.match(service, /child\.branch_id IN/);
  assert.match(service, /NOT child\.id = ANY\(tree\.path\)/);
});