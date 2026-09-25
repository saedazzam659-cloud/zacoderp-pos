import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  authoritativeCumulativeBillAmounts,
  aggregateContractProgressAmounts,
  calculateAdvanceRecoveryCents,
  autoRecoveryApplicationIdempotencyKey,
  isNewContractingApprovalStatus,
  isContractAdvanceWithinCap,
  contractingBillUnapprovalJournalAction,
  contractingCeilingAllocation,
  contractingBillRoleLines,
  idempotencyDecision,
  materialMovementCost,
  priorCertifiedContractGross,
  reverseAccountingLines,
  validateSettlementCap,
} from "../src/lib/contracting-accounting-math.ts";
import {
  contractingAdvanceRecoveryOverrideAllowed,
  contractingAdvanceRecoverySnapshotLocked,
} from "../src/lib/contracting-security.ts";
import { calculateSignedContractingBillNet } from "../src/lib/contracting-bill-adjustment-math.ts";

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

test("owner outgoing VAT taxes period gross before retention and balances its journal", () => {
  const amounts = authoritativeCumulativeBillAmounts({
    direction: "outgoing",
    grossAmount: "500000.00",
    retentionPercent: "10",
    vatPercent: "15",
    priorGrossAmount: "0",
    priorRetentionAmount: "0",
  });
  assert.deepEqual(amounts, {
    grossAmount: "500000.00",
    previousPaid: "0.00",
    retentionAmount: "50000.00",
    dueAmount: "450000.00",
    vatAmount: "75000.00",
    netAmount: "525000.00",
  });
  const lines = contractingBillRoleLines({ direction: "outgoing", ...amounts });
  assert.deepEqual(lines.map(({ role, debit, credit }) => [role, debit, credit]), [
    ["receivable", "525000.00", "0.00"],
    ["retention_receivable", "50000.00", "0.00"],
    ["revenue", "0.00", "500000.00"],
    ["vat_output", "0.00", "75000.00"],
  ]);
  assert.deepEqual(totals(lines), { debit: 575000, credit: 575000 });
  // Omission deliberately retains the incoming/legacy due-after-retention mode.
  assert.equal(authoritativeCumulativeBillAmounts({
    grossAmount: "500000", retentionPercent: "10", vatPercent: "15",
    priorGrossAmount: "0", priorRetentionAmount: "0",
  }).vatAmount, "67500.00");
});

test("owner cumulative VAT taxes only newly certified work, not cumulative work or retention release", () => {
  const prior = priorCertifiedContractGross({
    projectId: 7, direction: "outgoing", ownerContractId: 12,
    bills: [
      { projectId: 7, direction: "outgoing", ownerContractId: 12, grossAmount: "200000", retentionAmount: "20000", status: "approved" },
      { projectId: 7, direction: "outgoing", ownerContractId: 12, grossAmount: "300000", retentionAmount: "10000", status: "paid" },
    ],
  });
  assert.deepEqual(prior, { grossAmount: "300000.00", retentionAmount: "30000.00" });
  const input = {
    direction: "outgoing" as const,
    grossAmount: "500000", adjustedContractValue: "1000000",
    retentionPercent: "10", retentionCapPercent: "4",
    vatPercent: "15", priorGrossAmount: prior.grossAmount, priorRetentionAmount: prior.retentionAmount,
  };
  const manual = authoritativeCumulativeBillAmounts(input);
  assert.equal(manual.previousPaid, "300000.00");
  assert.equal(manual.retentionAmount, "10000.00");
  assert.equal(manual.dueAmount, "190000.00");
  assert.equal(manual.vatAmount, "30000.00");
  assert.equal(manual.netAmount, "220000.00");
  const aggregate = aggregateContractProgressAmounts({
    direction: "outgoing", adjustedContractValue: "1000000",
    progressPercent: "50", priorGrossAmount: prior.grossAmount,
    priorRetentionAmount: prior.retentionAmount,
    retentionPercent: "10", retentionCapPercent: "4", vatPercent: "15",
  });
  assert.equal(aggregate.currentPeriodGrossAmount, "200000.00");
  assert.equal(aggregate.vatAmount, manual.vatAmount);
  assert.equal(aggregate.netAmount, manual.netAmount);
  assert.equal(aggregateContractProgressAmounts({
    direction: "incoming", adjustedContractValue: "1000000",
    progressPercent: "50", priorGrossAmount: prior.grossAmount,
    priorRetentionAmount: prior.retentionAmount,
    retentionPercent: "10", retentionCapPercent: "4", vatPercent: "15",
  }).vatAmount, "30000.00");
});

test("explicit incoming and outgoing tax period work before retention in manual and aggregate modes", () => {
  for (const direction of ["outgoing", "incoming"] as const) {
    for (const retentionPercent of ["10", "0"]) {
      const manual = authoritativeCumulativeBillAmounts({
        direction, grossAmount: "100000", retentionPercent, vatPercent: "15",
        priorGrossAmount: "0", priorRetentionAmount: "0",
      });
      const aggregate = aggregateContractProgressAmounts({
        direction, adjustedContractValue: "100000", progressPercent: "100",
        priorGrossAmount: "0", priorRetentionAmount: "0",
        retentionPercent, vatPercent: "15",
      });
      const retention = retentionPercent === "10" ? "10000.00" : "0.00";
      const net = retentionPercent === "10" ? "105000.00" : "115000.00";
      for (const amounts of [manual, aggregate]) {
        assert.equal(amounts.retentionAmount, retention);
        assert.equal(amounts.vatAmount, "15000.00");
        assert.equal(amounts.netAmount, net);
        assert.equal(Number(amounts.dueAmount) + Number(amounts.retentionAmount) + Number(amounts.vatAmount), 115000);
      }
      const lines = contractingBillRoleLines({ direction, ...manual });
      assert.equal(totals(lines).debit, totals(lines).credit);
    }
  }
});

test("incoming subsequent cumulative certification taxes only the new period with retention cap and selected VAT rate", () => {
  const first = authoritativeCumulativeBillAmounts({
    direction: "incoming", grossAmount: "30000", adjustedContractValue: "100000",
    retentionPercent: "10", retentionCapPercent: "4", vatPercent: "5",
    priorGrossAmount: "0", priorRetentionAmount: "0",
  });
  const manual = authoritativeCumulativeBillAmounts({
    direction: "incoming", grossAmount: "50000", adjustedContractValue: "100000",
    retentionPercent: "10", retentionCapPercent: "4", vatPercent: "5",
    priorGrossAmount: first.grossAmount, priorRetentionAmount: first.retentionAmount,
  });
  const aggregate = aggregateContractProgressAmounts({
    direction: "incoming", adjustedContractValue: "100000", progressPercent: "50",
    priorGrossAmount: first.grossAmount, priorRetentionAmount: first.retentionAmount,
    retentionPercent: "10", retentionCapPercent: "4", vatPercent: "5",
  });
  for (const amounts of [manual, aggregate]) {
    assert.equal(amounts.previousPaid, "30000.00");
    assert.equal(amounts.retentionAmount, "1000.00");
    assert.equal(amounts.dueAmount, "19000.00");
    assert.equal(amounts.vatAmount, "1000.00");
    assert.equal(amounts.netAmount, "20000.00");
  }
});

test("zero VAT preserves retention and cash arithmetic for both directions", () => {
  for (const direction of ["incoming", "outgoing"] as const) {
    const amounts = authoritativeCumulativeBillAmounts({
      direction, grossAmount: "100000", retentionPercent: "10", vatPercent: "0",
      priorGrossAmount: "0", priorRetentionAmount: "0",
    });
    assert.equal(amounts.vatAmount, "0.00");
    assert.equal(amounts.netAmount, "90000.00");
    assert.equal(aggregateContractProgressAmounts({
      direction, adjustedContractValue: "100000", progressPercent: "100",
      priorGrossAmount: "0", retentionPercent: "10", vatPercent: "0",
    }).netAmount, "90000.00");
  }
});

test("both bill directions are wired to VAT math while historical snapshots stay immutable", () => {
  const service = readFileSync(new URL("../src/lib/contracting-accounting-service.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/routes/contracting.ts", import.meta.url), "utf8");
  const details = readFileSync(new URL("../src/lib/contracting-bill-details-service.ts", import.meta.url), "utf8");
  const argumentsPassed = (source: string, helper: string) =>
    Array.from(source.matchAll(new RegExp(`${helper}\\(\\{\\s*direction(?:: ([\\w.]+))?,`, "g")), match => match[1] ?? "direction");
  assert.deepEqual(argumentsPassed(service, "authoritativeCumulativeBillAmounts"), [
    "bill.direction", // approval, including detailed certificates
    "input.direction", // draft recovery preview
  ]);
  assert.deepEqual(argumentsPassed(route, "aggregateContractProgressAmounts"), ["input.direction"]);
  assert.deepEqual(argumentsPassed(route, "authoritativeCumulativeBillAmounts"), ["direction", "direction"]);
  assert.equal((route.match(/if \(!aggregateRequested\) \{/g) ?? []).length, 2);
  assert.match(route, /if \(\["approved", "posted", "partially_paid", "paid", "reversed"\]\.includes\(String\(cur\.status\)\) \|\|\s*cur\.journalEntryId/);
  assert.doesNotMatch(route, /dueAmount \* vatPct/);
  const screen = readFileSync(new URL("../../zatca-invoicing/src/pages/ContractingProjectDetail.tsx", import.meta.url), "utf8");
  assert.match(screen, /const previewVatBase = currentPeriodGross;/);
  assert.doesNotMatch(screen, /const previewVatBase = direction === "outgoing"/);
  // Omitted direction is reserved for unaudited legacy callers, not bill writes.
  assert.equal(authoritativeCumulativeBillAmounts({
    grossAmount: "100000", retentionPercent: "10", vatPercent: "15",
    priorGrossAmount: "0", priorRetentionAmount: "0",
  }).vatAmount, "13500.00");
  // Approval is the sole recertification boundary. An already-approved bill
  // (including a legacy approved bill whose journal is still draft) returns
  // or errors before the amount calculation; detail/report reads use snapshots.
  assert.ok(service.indexOf('if (locked.status === "approved" && locked.journalEntryId)') <
    service.indexOf("Object.assign(locked, await certifyBillAmounts("));
  assert.match(details, /vatAmount: Number\(bill\.vatAmount\)/);
});

test("advance recovery treats an explicit zero contractual cap differently from legacy omission", () => {
  const input = {
    enabled: true,
    progressPercent: "50",
    startProgressPercent: "0",
    advanceRecoveryPercent: "10",
    currentCertifiedWorkBeforeVat: "1000",
    actualAdvanceRemaining: "500",
    netDue: "1000",
  };
  assert.equal(calculateAdvanceRecoveryCents(input).recoveryAmount, "100.00");
  assert.equal(
    calculateAdvanceRecoveryCents({ ...input, contractAdvanceAmount: "0" }).recoveryAmount,
    "0.00",
  );
});

test("reapproval cannot create another journal or recover an advance from settled bills", () => {
  for (const status of ["draft", "submitted", "under_review", "rejected"]) {
    assert.equal(isNewContractingApprovalStatus(status), true);
  }
  for (const status of ["approved", "posted", "partially_paid", "paid", "reversed"]) {
    assert.equal(isNewContractingApprovalStatus(status), false);
  }
});

test("direct advances cannot exceed the approved contract's advance ceiling", () => {
  assert.equal(isContractAdvanceWithinCap("400000.00", "0", "400000"), true);
  assert.equal(isContractAdvanceWithinCap("100000.00", "300000", "400000"), true);
  assert.equal(isContractAdvanceWithinCap("100000.01", "300000", "400000"), false);
  assert.equal(isContractAdvanceWithinCap("0.01", "0", "0"), false);
});

test("unapproval cancels never-posted source entries without a financial reversal", () => {
  assert.equal(contractingBillUnapprovalJournalAction("draft"), "cancel_draft");
  assert.equal(contractingBillUnapprovalJournalAction("posted"), "reverse_posted");
  assert.equal(contractingBillUnapprovalJournalAction("cancelled"), null);
  assert.equal(contractingBillUnapprovalJournalAction("missing"), null);
});

test("recovery uses period pre-VAT work, signed net cap, actual advance and contractual cap in both directions", () => {
  for (const direction of ["outgoing", "incoming"]) {
    const input = {
      enabled: true, progressPercent: "40", startProgressPercent: "0",
      advanceRecoveryPercent: "40", method: "percentage",
      currentCertifiedWorkBeforeVat: "1000000", netDue: "1092500",
      actualAdvanceRemaining: "400000", contractAdvanceAmount: "400000",
      totalPreviouslyRecovered: "0",
    };
    assert.equal(calculateAdvanceRecoveryCents(input).recoveryAmount, "400000.00", direction);
    assert.equal(calculateAdvanceRecoveryCents({ ...input, progressPercent: "39.99", startProgressPercent: "40" }).recoveryAmount, "0.00", direction);
    assert.equal(calculateAdvanceRecoveryCents({ ...input, startProgressPercent: "40" }).recoveryAmount, "400000.00", direction);
    assert.equal(calculateAdvanceRecoveryCents({ ...input, actualAdvanceRemaining: "0" }).recoveryAmount, "0.00", direction);
    assert.equal(calculateAdvanceRecoveryCents({ ...input, totalPreviouslyRecovered: "350000" }).recoveryAmount, "50000.00", direction);
    assert.equal(calculateAdvanceRecoveryCents({ ...input, netDue: "50000" }).recoveryAmount, "50000.00", direction);
    assert.equal(calculateAdvanceRecoveryCents({ ...input, method: "fixed", fixedAmount: "60000" }).recoveryAmount, "60000.00", direction);
  }
});

test("auto-recovery cycle idempotency changes after unapproval while retrying same cycle is stable", () => {
  const first = autoRecoveryApplicationIdempotencyKey(7, 101, 22, "10.00");
  assert.equal(first, autoRecoveryApplicationIdempotencyKey(7, 101, 22, "10.00"));
  assert.notEqual(first, autoRecoveryApplicationIdempotencyKey(7, 102, 22, "10.00"));
});

test("ordinary posting authority cannot request an exceptional recovery override", () => {
  assert.equal(
    contractingAdvanceRecoveryOverrideAllowed({
      role: "user",
      postingPermissions: { ctgOutgoingBill: { post: true } },
    } as any),
    false,
  );
  assert.equal(
    contractingAdvanceRecoveryOverrideAllowed({
      role: "user",
      permissions: { contracting: { overrun: true } },
    }),
    true,
  );
  assert.equal(contractingAdvanceRecoveryOverrideAllowed({ role: "admin" }), true);
});

test("reopened submitted bill uses live policy while active and reversed history stays frozen", () => {
  assert.equal(
    contractingAdvanceRecoverySnapshotLocked({
      status: "submitted",
      journalEntryId: 10,
      reversalJournalEntryId: 11,
    }),
    false,
  );
  assert.equal(
    contractingAdvanceRecoverySnapshotLocked({
      status: "submitted",
      journalEntryId: 10,
      reversalJournalEntryId: null,
    }),
    true,
  );
  assert.equal(contractingAdvanceRecoverySnapshotLocked({ status: "reversed" }), true);
});

test("aggregate percentage uses adjusted contract base and current period delta", () => {
  const amounts = aggregateContractProgressAmounts({
    adjustedContractValue: "100000",
    progressPercent: "30",
    priorGrossAmount: "20000",
    priorRetentionAmount: "1000",
    retentionPercent: "5",
    vatPercent: "15",
  });
  assert.equal(amounts.cumulativeGrossAmount, "30000.00");
  assert.equal(amounts.currentPeriodGrossAmount, "10000.00");
  assert.equal(amounts.previousPaid, "20000.00");
  assert.equal(amounts.retentionAmount, "500.00");
  assert.equal(amounts.dueAmount, "9500.00");
  assert.equal(amounts.vatAmount, "1425.00");
  assert.equal(amounts.netAmount, "10925.00");
});

test("retention cap is cumulative across sequential aggregate certifications", () => {
  const first = aggregateContractProgressAmounts({
    adjustedContractValue: "100000",
    progressPercent: "50",
    priorGrossAmount: "0",
    priorRetentionAmount: "0",
    retentionEnabled: true,
    retentionPercent: "5",
    retentionCapPercent: "2",
    vatPercent: "15",
  });
  assert.equal(first.cumulativeGrossAmount, "50000.00");
  assert.equal(first.retentionAmount, "2000.00");

  const second = aggregateContractProgressAmounts({
    adjustedContractValue: "100000",
    progressPercent: "100",
    priorGrossAmount: first.cumulativeGrossAmount,
    priorRetentionAmount: first.retentionAmount,
    retentionEnabled: true,
    retentionPercent: "5",
    retentionCapPercent: "2",
    vatPercent: "15",
  });
  assert.equal(second.cumulativeGrossAmount, "100000.00");
  assert.equal(second.retentionAmount, "0.00");
  assert.equal(second.dueAmount, "50000.00");
});

test("disabled retention on a new contract produces no retention delta", () => {
  const amounts = aggregateContractProgressAmounts({
    adjustedContractValue: "100000",
    progressPercent: "25",
    priorGrossAmount: "0",
    priorRetentionAmount: "0",
    retentionEnabled: false,
    retentionPercent: "5",
    retentionCapPercent: "2",
    vatPercent: "15",
  });
  assert.equal(amounts.retentionAmount, "0.00");
  assert.equal(amounts.dueAmount, "25000.00");
});

test("legacy bill math remains uncapped when no retention snapshot exists", () => {
  assert.deepEqual(authoritativeCumulativeBillAmounts({
    grossAmount: "1500",
    retentionPercent: "5",
    vatPercent: "15",
    priorGrossAmount: "0",
    priorRetentionAmount: "0",
    retentionEnabled: null,
    retentionCapPercent: null,
    adjustedContractValue: "100",
  }), {
    grossAmount: "1500.00",
    previousPaid: "0.00",
    retentionAmount: "75.00",
    dueAmount: "1425.00",
    vatAmount: "213.75",
    netAmount: "1638.75",
  });
});

test("prior aggregate certification excludes reversals and sibling contracts", () => {
  const prior = priorCertifiedContractGross({
    projectId: 7,
    direction: "outgoing",
    ownerContractId: 12,
    subcontractorContractId: null,
    bills: [
      { id: 1, projectId: 7, direction: "outgoing", ownerContractId: 12, subcontractorContractId: null, grossAmount: "20000", retentionAmount: "1000", status: "approved" },
      { id: 2, projectId: 7, direction: "outgoing", ownerContractId: 12, subcontractorContractId: null, grossAmount: "50000", retentionAmount: "2500", status: "reversed", reversalJournalEntryId: 9 },
      { id: 3, projectId: 7, direction: "outgoing", ownerContractId: 99, subcontractorContractId: null, grossAmount: "90000", retentionAmount: "4500", status: "approved" },
    ],
  });
  assert.deepEqual(prior, { grossAmount: "20000.00", retentionAmount: "1000.00" });
});

test("prior retention sums saved period deltas across sequential cumulative bills", () => {
  const prior = priorCertifiedContractGross({
    projectId: 7,
    direction: "outgoing",
    ownerContractId: 12,
    subcontractorContractId: null,
    bills: [
      { id: 1, projectId: 7, direction: "outgoing", ownerContractId: 12, subcontractorContractId: null, grossAmount: "20000", retentionAmount: "1000", status: "approved" },
      { id: 2, projectId: 7, direction: "outgoing", ownerContractId: 12, subcontractorContractId: null, grossAmount: "30000", retentionAmount: "500", status: "approved" },
      { id: 3, projectId: 7, direction: "outgoing", ownerContractId: 12, subcontractorContractId: null, grossAmount: "40000", retentionAmount: "500", status: "approved" },
    ],
  });
  assert.deepEqual(prior, { grossAmount: "40000.00", retentionAmount: "2000.00" });
  assert.deepEqual(authoritativeCumulativeBillAmounts({
    grossAmount: "50000",
    retentionPercent: "5",
    vatPercent: "15",
    priorGrossAmount: prior.grossAmount,
    priorRetentionAmount: prior.retentionAmount,
  }), {
    grossAmount: "50000.00",
    previousPaid: "40000.00",
    retentionAmount: "500.00",
    dueAmount: "9500.00",
    vatAmount: "1425.00",
    netAmount: "10925.00",
  });
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

test("advance recovery uses current certified work, start threshold, and actual balance caps", () => {
  const eligible = calculateAdvanceRecoveryCents({
    enabled: true,
    progressPercent: "35",
    startProgressPercent: "30",
    advanceRecoveryPercent: "10",
    currentCertifiedWorkBeforeVat: "1234.57",
    actualAdvanceRemaining: "100.00",
    netDue: "80.00",
  });
  assert.equal(eligible.requestedRecoveryAmount, "123.46");
  assert.equal(eligible.recoveryAmount, "80.00");
  assert.equal(eligible.remainingAdvanceAfter, "20.00");

  const belowThreshold = calculateAdvanceRecoveryCents({
    enabled: true,
    progressPercent: "29.99",
    startProgressPercent: "30",
    advanceRecoveryPercent: "10",
    currentCertifiedWorkBeforeVat: "5000",
    actualAdvanceRemaining: "1000",
    netDue: "5000",
  });
  assert.equal(belowThreshold.requestedRecoveryAmount, "0.00");
  assert.equal(belowThreshold.startReached, false);
});

test("signed adjustments reduce recovery and receipt caps exactly once", () => {
  const adjusted = calculateSignedContractingBillNet({
    rawNetAmount: "1000.00",
    additions: [{ amount: "200.00" }],
    deductions: [{ kind: "materials", amount: "300.00" }],
    penalties: [{ amount: "100.00" }],
  });
  assert.equal(adjusted.signedAdjustmentAmount, "-200.00");
  assert.equal(adjusted.adjustedNetAmount, "800.00");
  const recovery = calculateAdvanceRecoveryCents({
    enabled: true,
    progressPercent: "50",
    startProgressPercent: "0",
    advanceRecoveryPercent: "100",
    currentCertifiedWorkBeforeVat: "900.00",
    actualAdvanceRemaining: "2000.00",
    netDue: adjusted.adjustedNetAmount,
  });
  assert.equal(recovery.requestedRecoveryAmount, "900.00");
  assert.equal(recovery.recoveryAmount, "800.00");
});

test("mock executor makes duplicate settlement replay-safe and rejects a missing key", () => {
  const executor = new MockAccountingExecutor();
  assert.deepEqual(executor.postSettlement("settlement-1"), { state: "posted" });
  assert.deepEqual(executor.postSettlement("settlement-1"), { state: "replayed" });
  const missing = executor.postSettlement("   ");
  assert.equal(missing.state, "rejected");
  assert.match(String(missing.reason), /مفتاح العملية/);
});

test("contract ceiling grants the base once across base and multiple approved orders", () => {
  const allocation = contractingCeilingAllocation({
    baseValue: "100.10",
    approvedOrderValues: ["20.20", "30.30"],
    priorScopeValue: "100.10",
    priorBucketValue: "0.00",
    currentValue: "20.20",
    selectedOrderValue: "20.20",
  });
  assert.deepEqual(allocation, {
    totalLimit: "150.60",
    bucketLimit: "20.20",
    scopeExceeded: false,
    bucketExceeded: false,
  });
  assert.equal(contractingCeilingAllocation({
    baseValue: "100.10",
    approvedOrderValues: ["20.20", "30.30"],
    priorScopeValue: "120.30",
    priorBucketValue: "20.20",
    currentValue: "30.31",
    selectedOrderValue: "30.30",
  }).scopeExceeded, true);
});

test("posted correction rollback leaves reversal and source unchanged when copy fails", () => {
  const store = { source: "posted", reversal: false, draft: false };
  const snapshot = { ...store };
  assert.throws(() => {
    try {
      store.reversal = true;
      throw new Error("detail copy failed");
    } catch (error) {
      Object.assign(store, snapshot);
      throw error;
    }
  }, /detail copy failed/);
  assert.deepEqual(store, snapshot);
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