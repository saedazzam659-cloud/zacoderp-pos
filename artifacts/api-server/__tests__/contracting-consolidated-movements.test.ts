import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { certificateCostResidual, filterConsolidatedMovements, summarizeConsolidatedMovements } from "../src/lib/project-financial-sources.js";

test("period and operation filters select the exact same signed rows used in totals", () => {
  const rows = [
    { sourceType: "sales_invoice", sourceId: 1, sourceDate: "2026-01-31", documentNumber: null, category: "revenue", revenueAmount: 90, costAmount: 0, cashAmount: 0 },
    { sourceType: "sales_return", sourceId: 2, sourceDate: "2026-02-01", documentNumber: null, category: "revenue", revenueAmount: -20, costAmount: 0, cashAmount: 0 },
    { sourceType: "contracting_cost_allocation", sourceId: 3, sourceDate: "2026-02-01", documentNumber: null, category: "payroll", revenueAmount: 0, costAmount: 37, cashAmount: 0 },
    { sourceType: "contracting_cost_allocation", sourceId: 4, sourceDate: "2026-02-02", documentNumber: null, category: "payroll", revenueAmount: 0, costAmount: -7, cashAmount: 0 },
    { sourceType: "receipt_voucher", sourceId: 5, sourceDate: "2026-02-02", documentNumber: null, category: "cash", revenueAmount: 0, costAmount: 0, cashAmount: 70 },
    { sourceType: "goods_receipt", sourceId: 6, sourceDate: "2026-02-02", documentNumber: null, category: "inventory_receipt", revenueAmount: 0, costAmount: 0, cashAmount: 0 },
  ];
  assert.deepEqual(summarizeConsolidatedMovements(filterConsolidatedMovements(rows, {
    dateFrom: "2026-02-01", dateTo: "2026-02-02", operationType: "all",
  })), { revenue: -20, cost: 30, profit: -50, cash: 70 });
  assert.deepEqual(summarizeConsolidatedMovements(filterConsolidatedMovements(rows, {
    dateFrom: "2026-02-01", dateTo: "2026-02-02", operationType: "cost",
  })), { revenue: 0, cost: 30, profit: -30, cash: 0 });
  assert.equal(filterConsolidatedMovements(rows, { operationType: "inventory" }).length, 1);
});

test("partial subcontract allocation only removes its globally owned share", () => {
  assert.equal(certificateCostResidual(100, 40), 60);
  assert.equal(certificateCostResidual(100, 100), 0);
  assert.equal(certificateCostResidual(100, 0), 100);
  assert.equal(certificateCostResidual(100, 120), 0);
});

test("cash fallback only applies when no line or existing settlement link can own voucher", () => {
  const source = readFileSync(new URL("../src/lib/project-financial-sources.ts", import.meta.url), "utf8");
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM receipt_voucher_lines l WHERE l\.voucher_id=v\.id\)/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM payment_voucher_lines l WHERE l\.voucher_id=v\.id\)/);
  assert.match(source, /sl\.source_type='receipt_voucher' AND sl\.source_id=v\.id/);
  assert.match(source, /sl\.source_type='payment_voucher' AND sl\.source_id=v\.id/);
  assert.match(source, /pr\.status='posted' AND EXISTS \(SELECT 1 FROM journal_entries j/);
  assert.match(source, /dep\.status='posted' AND EXISTS \(SELECT 1 FROM journal_entries j/);
  assert.match(source, /je\.entry_type IN \('general','opening','closing','adjustment','depreciation'\)/);
});

test("owner certificates are not globally suppressed by unrelated sales invoices", () => {
  const service = readFileSync(new URL("../src/lib/contracting-project-reports-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /hasInvoiceRevenue/);
  assert.match(service, /ownerBill \? rounded\(numberValue\(bill\.amount\)\)/);
  assert.match(service, /certificateCostResidual\(numberValue\(bill\.amount\), allocatedSubcontractBills\.get/);
});