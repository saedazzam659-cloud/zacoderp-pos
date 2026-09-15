import test from "node:test";
import assert from "node:assert/strict";

import {
  authoritativeCumulativeBillAmounts,
  contractingBillRoleLines,
  idempotencyDecision,
  materialMovementCost,
  reverseAccountingLines,
  validateSettlementCap,
} from "../src/lib/contracting-accounting-math.ts";

/**
 * Deliberately tiny in-memory executor.  It models only the state transitions
 * needed by the regression cases, so this test never needs a tenant/database
 * fixture or a full API workflow.
 */
class MockAccountingExecutor {
  private readonly settlementKeys = new Set<string>();

  postSettlement(idempotencyKey: string) {
    const decision = idempotencyDecision(idempotencyKey, this.settlementKeys);
    if (!decision.ok) return { state: "rejected", reason: decision.reason };
    if (decision.replay) return { state: "replayed" };
    this.settlementKeys.add(idempotencyKey.trim());
    return { state: "posted" };
  }
}

function totals(lines: Array<{ debit: string; credit: string }>) {
  return lines.reduce(
    (sum, line) => ({
      debit: sum.debit + Number(line.debit),
      credit: sum.credit + Number(line.credit),
    }),
    { debit: 0, credit: 0 },
  );
}

test("approved outgoing bill amounts balance and reversal swaps every side", () => {
  const lines = contractingBillRoleLines({
    direction: "outgoing",
    grossAmount: "1500.00",
    previousPaid: "950.00",
    retentionAmount: "75.00",
    vatAmount: "71.25",
    netAmount: "546.25",
    billNumber: "OB-002",
  });
  assert.deepEqual(lines.map((line) => [line.role, line.debit, line.credit]), [
    ["receivable", "546.25", "0.00"],
    ["retention_receivable", "75.00", "0.00"],
    ["revenue", "0.00", "550.00"],
    ["vat_output", "0.00", "71.25"],
  ]);
  assert.deepEqual(totals(lines), { debit: 621.25, credit: 621.25 });

  const reversed = reverseAccountingLines(lines);
  assert.deepEqual(totals(reversed), { debit: 621.25, credit: 621.25 });
  assert.equal(reversed[0].debit, "0.00");
  assert.equal(reversed[0].credit, "546.25");
  assert.match(reversed[0].description, /^عكس:/);
});

test("approved incoming subcontractor bill keeps WIP, payable, retention and VAT balanced", () => {
  const lines = contractingBillRoleLines({
    direction: "incoming",
    grossAmount: 800,
    previousPaid: 200,
    retentionAmount: 30,
    vatAmount: 85.5,
    netAmount: 655.5,
    billNumber: "IB-004",
  });
  assert.deepEqual(lines.map((line) => line.role), ["wip", "vat_input", "payable", "retention_payable"]);
  assert.deepEqual(totals(lines), { debit: 685.5, credit: 685.5 });
});

test("cumulative certification uses prior certified totals, never paid amount", () => {
  const amounts = authoritativeCumulativeBillAmounts({
    grossAmount: "1500.00",
    retentionPercent: "5",
    vatPercent: "15",
    priorGrossAmount: "950.00",
    priorRetentionAmount: "47.50",
  });
  assert.deepEqual(amounts, {
    grossAmount: "1500.00",
    previousPaid: "950.00",
    retentionAmount: "27.50",
    dueAmount: "522.50",
    vatAmount: "78.38",
    netAmount: "600.88",
  });
  assert.throws(() => authoritativeCumulativeBillAmounts({
    grossAmount: "900",
    retentionPercent: "5",
    vatPercent: "15",
    priorGrossAmount: "950",
    priorRetentionAmount: "47.50",
  }), /أقل من آخر مستخلص/);
});

test("advance, retention and bill settlement caps reject over-application", () => {
  assert.equal(validateSettlementCap({
    kind: "advance_application", requested: 200, availableAdvance: 200,
  }).ok, true);
  assert.equal(validateSettlementCap({
    kind: "advance_application", requested: 200.01, availableAdvance: 200,
  }).ok, false);

  assert.equal(validateSettlementCap({
    kind: "retention_receipt", requested: 30, retentionAmount: 100, alreadyReleased: 70,
  }).ok, true);
  assert.equal(validateSettlementCap({
    kind: "retention_receipt", requested: 30.01, retentionAmount: 100, alreadyReleased: 70,
  }).ok, false);

  const billCap = validateSettlementCap({
    kind: "bill_payment", requested: 150.01, billNetAmount: 1000, billPaidAmount: 850,
  });
  assert.deepEqual(billCap, {
    ok: false,
    reason: "مبلغ التسوية يتجاوز رصيد المستخلص المتبقي",
  });
});

test("mock executor makes duplicate settlement replay-safe and rejects a missing key", () => {
  const executor = new MockAccountingExecutor();
  assert.deepEqual(executor.postSettlement("settlement-1"), { state: "posted" });
  assert.deepEqual(executor.postSettlement("settlement-1"), { state: "replayed" });
  const missing = executor.postSettlement("   ");
  assert.equal(missing.state, "rejected");
  assert.match(String(missing.reason), /مفتاح العملية/);
});

test("material issue/return uses source cost and rejects excessive returns", () => {
  const issue = materialMovementCost({
    direction: "issue", qtyBase: 10, unitCost: "12.34",
  });
  assert.deepEqual(issue, { ok: true, qtyBase: 10, unitCost: 12.34, totalCost: 123.4 });

  const returned = materialMovementCost({
    direction: "return",
    qtyBase: 4,
    unitCost: "12.34",
    sourceQtyBase: 10,
    alreadyReturnedBase: 3,
  });
  assert.deepEqual(returned, { ok: true, qtyBase: 4, unitCost: 12.34, totalCost: 49.36 });

  const excessive = materialMovementCost({
    direction: "return",
    qtyBase: 8,
    unitCost: "12.34",
    sourceQtyBase: 10,
    alreadyReturnedBase: 3,
  });
  assert.equal(excessive.ok, false);
  assert.match(excessive.reason, /تتجاوز/);
  assert.equal(materialMovementCost({
    direction: "return", qtyBase: 1, unitCost: 0,
    sourceQtyBase: 10, alreadyReturnedBase: 0,
  }).ok, false);
});