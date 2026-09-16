/**
 * Deterministic monetary rules for contracting accounting.
 *
 * This module intentionally has no database imports.  The posting service
 * uses these functions after locking its source rows, while the focused
 * regression tests can exercise amount/reversal/cap rules with a memory
 * executor instead of needing a PostgreSQL tenant fixture.
 */

export type ContractingBillInput = {
  direction: "outgoing" | "incoming";
  grossAmount: number | string;
  previousPaid: number | string;
  retentionAmount: number | string;
  vatAmount: number | string;
  netAmount: number | string;
  billNumber?: string | null;
};

export type AccountingRoleLine = {
  role: string;
  debit: string;
  credit: string;
  description: string;
};

const numberValue = (value: number | string | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const moneyValue = (value: number): string => value.toFixed(2);

export function contractingBillAmounts(input: ContractingBillInput) {
  const period = Math.max(0, numberValue(input.grossAmount) - numberValue(input.previousPaid));
  return {
    period,
    retention: numberValue(input.retentionAmount),
    vat: numberValue(input.vatAmount),
    net: numberValue(input.netAmount),
  };
}

function scaledCents(value: number | string): bigint {
  const raw = String(value ?? "0").trim();
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const cents = BigInt(whole || "0") * 100n
    + BigInt((fraction + "00").slice(0, 2) || "0");
  return negative ? -cents : cents;
}

function centsString(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

/**
 * Calculate the automatic recovery for one certified period.  This is kept
 * entirely in integer cents so the same policy is used by approval and the
 * read-only bill preview:
 *
 *   current certified work before VAT × recovery rate
 *
 * `previous certified work` is intentionally absent. The caller supplies the
 * current period delta, which prevents cumulative bills from recovering the
 * same work twice. The result is capped by both the actual posted advance
 * balance and the bill's net due.
 */
export function calculateAdvanceRecoveryCents(input: {
  enabled: boolean;
  progressPercent: number | string;
  startProgressPercent: number | string;
  advanceRecoveryPercent: number | string;
  method?: "percentage" | "fixed" | string | null;
  fixedAmount?: number | string | null;
  contractAdvanceAmount?: number | string | null;
  totalPreviouslyRecovered?: number | string | null;
  currentCertifiedWorkBeforeVat: number | string;
  actualAdvanceRemaining: number | string;
  netDue: number | string;
  overrideAmount?: number | string | null;
}) {
  const progress = percentCents(input.progressPercent);
  const start = percentCents(input.startProgressPercent);
  const rate = percentCents(input.advanceRecoveryPercent);
  const method = String(input.method ?? "percentage") === "fixed" ? "fixed" : "percentage";
  const fixedAmount = scaledCents(input.fixedAmount ?? "0");
  const contractAdvanceAmount = scaledCents(input.contractAdvanceAmount ?? "0");
  const totalPreviouslyRecovered = scaledCents(input.totalPreviouslyRecovered ?? "0");
  const currentWork = scaledCents(input.currentCertifiedWorkBeforeVat);
  const advanceRemaining = scaledCents(input.actualAdvanceRemaining);
  const netDue = scaledCents(input.netDue);
  if (progress < 0n || progress > 10000n || start < 0n || start > 10000n) {
    throw new Error("نسبة الإنجاز وبداية استرداد السلفة يجب أن تكونا بين 0 و100");
  }
  if (rate < 0n || rate > 10000n) {
    throw new Error("نسبة استرداد السلفة يجب أن تكون بين 0 و100");
  }
  if (currentWork < 0n || advanceRemaining < 0n || netDue < 0n) {
    throw new Error("مبالغ استرداد السلفة لا يمكن أن تكون سالبة");
  }
  const startReached = progress >= start;
  if (fixedAmount < 0n || contractAdvanceAmount < 0n || totalPreviouslyRecovered < 0n) {
    throw new Error("مبالغ سياسة استرداد السلفة لا يمكن أن تكون سالبة");
  }
  const eligible = Boolean(input.enabled)
    && startReached
    // A fixed policy must still be tied to positive current certified work.
    // This preserves zero-financial execution certificates unless an explicit
    // override is supplied by the caller.
    && currentWork > 0n
    && (method === "fixed" ? fixedAmount > 0n : rate > 0n);
  const calculatedRequested = eligible
    ? method === "fixed" ? fixedAmount : multiplyCentsByPercent(currentWork, rate)
    : 0n;
  const requested = input.overrideAmount == null
    ? calculatedRequested
    : scaledCents(input.overrideAmount);
  if (requested < 0n) throw new Error("مبلغ استرداد السلفة لا يمكن أن يكون سالباً");
  // `0.00` is an explicit contractual cap and must disable recovery. Only an
  // omitted value keeps the legacy source-balance-only behavior.
  const hasContractCap = input.contractAdvanceAmount != null;
  const contractualRemaining = hasContractCap
    ? (contractAdvanceAmount > totalPreviouslyRecovered
      ? contractAdvanceAmount - totalPreviouslyRecovered
      : 0n)
    : advanceRemaining;
  const sourceCapped = requested < advanceRemaining ? requested : advanceRemaining;
  const contractualCapped = sourceCapped < contractualRemaining ? sourceCapped : contractualRemaining;
  const recovered = contractualCapped < netDue ? contractualCapped : netDue;
  const remainingAfter = advanceRemaining - recovered;
  return {
    enabled: Boolean(input.enabled),
    startReached,
    eligible,
    progressPercent: centsString(progress),
    startProgressPercent: centsString(start),
    advanceRecoveryPercent: centsString(rate),
    method,
    fixedAmount: centsString(fixedAmount),
    contractAdvanceAmount: centsString(contractAdvanceAmount),
    totalPreviouslyRecovered: centsString(totalPreviouslyRecovered),
    outstandingContractualAmount: centsString(contractualRemaining),
    currentCertifiedWorkBeforeVat: centsString(currentWork),
    actualAdvanceRemaining: centsString(advanceRemaining),
    netDue: centsString(netDue),
    requestedRecoveryAmount: centsString(requested),
    recoveryAmount: centsString(recovered),
    advanceRecoveryAmount: centsString(recovered),
    remainingAdvanceAfter: centsString(remainingAfter),
    remainingAfterRecovery: centsString(remainingAfter),
  };
}

// Descriptive aliases make the policy easy to discover without exposing the
// cent implementation details to callers.
export const calculateContractingAdvanceRecovery = calculateAdvanceRecoveryCents;
export const advanceRecoveryAmounts = calculateAdvanceRecoveryCents;
export const calculateAdvanceRecovery = calculateAdvanceRecoveryCents;
export const calculateAdvanceRecoveryPreview = calculateAdvanceRecoveryCents;

export function autoRecoveryApplicationIdempotencyKey(
  billId: number | string,
  approvalCycleId: number | string,
  sourceSettlementId: number | string,
  amount: number | string,
): string {
  return `auto-recovery:${billId}:${approvalCycleId}:${sourceSettlementId}:${amount}`;
}

/**
 * Contract ceiling allocation is intentionally calculated in integer cents:
 * the base contract is granted once to the whole scope, while a selected
 * change-order line can consume only that order's delta.
 */
export function contractingCeilingAllocation(input: {
  baseValue: number | string;
  approvedOrderValues: Array<number | string>;
  selectedOrderValue?: number | string | null;
  priorScopeValue: number | string;
  priorBucketValue: number | string;
  currentValue: number | string;
}) {
  // Add each source as cents rather than relying on a floating sum.
  const exactTotal = scaledCents(input.baseValue)
    + input.approvedOrderValues.reduce((sum, value) => sum + scaledCents(value), 0n);
  const bucketLimit = input.selectedOrderValue == null
    ? exactTotal
    : scaledCents(input.selectedOrderValue);
  const scopeUsed = scaledCents(input.priorScopeValue) + scaledCents(input.currentValue);
  const bucketUsed = scaledCents(input.priorBucketValue) + scaledCents(input.currentValue);
  return {
    totalLimit: centsString(exactTotal),
    bucketLimit: centsString(bucketLimit),
    scopeExceeded: scopeUsed > exactTotal,
    bucketExceeded: bucketUsed > bucketLimit,
  };
}

function percentCents(value: number | string): bigint {
  return scaledCents(value);
}

function multiplyCentsByPercent(cents: bigint, percent: bigint): bigint {
  // cents × (percent / 100), with half-up rounding to cents. `percent` is
  // stored in hundredths of a percent (e.g. 15.00 → 1500).
  const numerator = cents * percent;
  const denominator = 10000n;
  return (numerator + denominator / 2n) / denominator;
}

/**
 * Server-authoritative cumulative certification math.  `priorGrossAmount`
 * and `priorRetentionAmount` are maxima/sums of certified bills for the
 * locked contract, not paid amounts and not client-supplied `previousPaid`.
 * A non-null retention snapshot caps cumulative retention against the adjusted
 * contract value; a null cap is the compatibility path for legacy bills.
 */
export function authoritativeCumulativeBillAmounts(input: {
  grossAmount: number | string;
  adjustedContractValue?: number | string | null;
  retentionEnabled?: boolean | null;
  retentionPercent: number | string;
  retentionCapPercent?: number | string | null;
  vatPercent: number | string;
  priorGrossAmount: number | string;
  priorRetentionAmount: number | string;
}) {
  const gross = scaledCents(input.grossAmount);
  const priorGross = scaledCents(input.priorGrossAmount);
  const retentionBase = input.adjustedContractValue == null
    ? gross
    : scaledCents(input.adjustedContractValue);
  const requestedRetention = Boolean(input.retentionEnabled ?? true)
    ? multiplyCentsByPercent(gross, percentCents(input.retentionPercent))
    : 0n;
  const capPercent = input.retentionCapPercent == null
    ? null
    : percentCents(input.retentionCapPercent);
  const retentionCap = capPercent == null
    ? null
    : multiplyCentsByPercent(retentionBase, capPercent);
  const currentRetention = retentionCap == null || requestedRetention < retentionCap
    ? requestedRetention
    : retentionCap;
  const priorRetention = scaledCents(input.priorRetentionAmount);
  if (gross < priorGross) {
    throw new Error("إجمالي المستخلص التراكمي أقل من آخر مستخلص معتمد للعقد");
  }
  if (currentRetention < priorRetention) {
    throw new Error("محتجزات المستخلص التراكمي أقل من آخر محتجزات معتمدة للعقد");
  }
  const periodGross = gross - priorGross;
  const retentionDelta = currentRetention - priorRetention;
  const due = periodGross > retentionDelta ? periodGross - retentionDelta : 0n;
  const vat = multiplyCentsByPercent(due, percentCents(input.vatPercent));
  return {
    grossAmount: centsString(gross),
    previousPaid: centsString(priorGross),
    retentionAmount: centsString(retentionDelta),
    dueAmount: centsString(due),
    vatAmount: centsString(vat),
    netAmount: centsString(due + vat),
  };
}

/**
 * A progress bill's `grossAmount` is the certified cumulative work value
 * before VAT.  It is not the amount paid and it is not a period amount.  The
 * aggregate editor derives that cumulative value from the selected
 * contract's adjusted (approved) ceiling and a 0..100 percentage, then
 * derives the current period from the latest certified value for the exact
 * same contract.
 *
 * Keep this calculation free of database concerns.  Besides making the
 * rounding policy explicit, this lets the API and focused math tests share
 * exactly the same rules.
 */
export type CertifiedContractProgressBill = {
  id?: number | string | null;
  projectId?: number | string | null;
  direction: "outgoing" | "incoming";
  ownerContractId?: number | string | null;
  subcontractorContractId?: number | string | null;
  grossAmount: number | string;
  retentionAmount?: number | string | null;
  status: string;
  reversalJournalEntryId?: number | string | null;
};

const CERTIFIED_PROGRESS_STATUSES = new Set([
  "approved",
  "posted",
  "partially_paid",
  "paid",
]);

function sameNullableId(left: unknown, right: unknown): boolean {
  if (left == null || left === "") return right == null || right === "";
  return Number(left) === Number(right);
}

/**
 * Find the highest certified cumulative gross and the sum of saved period
 * retentions for one exact contract.
 *
 * Cumulative bills must not be summed: 20,000 followed by 30,000 means the
 * current period is 10,000, not 50,000. Retention is different: bills save
 * the period delta, so prior retention is the SUM of certified, non-reversed
 * period retentions (not MAX). Reversed rows are excluded both by workflow
 * state and by the reversal journal marker, and all project and contract
 * dimensions are matched exactly.
 */
export function priorCertifiedContractGross(input: {
  bills: readonly CertifiedContractProgressBill[];
  projectId?: number | string | null;
  direction: "outgoing" | "incoming";
  ownerContractId?: number | string | null;
  subcontractorContractId?: number | string | null;
  excludeBillId?: number | string | null;
}): {
  grossAmount: string;
  retentionAmount: string;
} {
  let gross = 0n;
  let retention = 0n;
  for (const bill of input.bills) {
    if (
      !CERTIFIED_PROGRESS_STATUSES.has(String(bill.status))
      || bill.reversalJournalEntryId != null
      || (input.excludeBillId != null && Number(bill.id) === Number(input.excludeBillId))
      || (input.projectId != null && !sameNullableId(bill.projectId, input.projectId))
      || bill.direction !== input.direction
      || !sameNullableId(bill.ownerContractId, input.ownerContractId)
      || !sameNullableId(bill.subcontractorContractId, input.subcontractorContractId)
    ) continue;
    const candidateGross = scaledCents(bill.grossAmount);
    const candidateRetention = scaledCents(bill.retentionAmount ?? 0);
    if (candidateGross > gross) gross = candidateGross;
     retention += candidateRetention;
  }
  return {
    grossAmount: centsString(gross),
    retentionAmount: centsString(retention),
  };
}

/**
 * Compute an aggregate percentage bill.  `adjustedContractValue` is already
 * the VAT-exclusive base plus approved change orders, while all returned
 * financial values follow the existing cumulative certification convention.
 * In particular, `previousPaid` is the previous certified cumulative gross;
 * it is not a second payment deduction.
 */
export function aggregateContractProgressAmounts(input: {
  adjustedContractValue: number | string;
  progressPercent: number | string;
  priorGrossAmount: number | string;
  priorRetentionAmount?: number | string;
  retentionEnabled?: boolean | null;
  retentionPercent: number | string;
  retentionCapPercent?: number | string | null;
  vatPercent: number | string;
}) {
  const progress = numberValue(input.progressPercent);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new Error("نسبة الإنجاز يجب أن تكون بين 0 و100");
  }
  const contractValue = scaledCents(input.adjustedContractValue);
  if (contractValue < 0n) throw new Error("قيمة العقد المعدلة يجب ألا تكون سالبة");
  const gross = multiplyCentsByPercent(contractValue, percentCents(progress));
  const priorGross = scaledCents(input.priorGrossAmount);
  const priorRetention = scaledCents(input.priorRetentionAmount ?? 0);
  if (gross < priorGross) {
    throw new Error("نسبة الإنجاز التراكمية أقل من آخر إنجاز معتمد للعقد");
  }

  const requestedRetention = Boolean(input.retentionEnabled ?? true)
    ? multiplyCentsByPercent(gross, percentCents(input.retentionPercent))
    : 0n;
  const capPercent = input.retentionCapPercent == null
    ? null
    : percentCents(input.retentionCapPercent);
  const retentionCap = capPercent == null
    ? null
    : multiplyCentsByPercent(contractValue, capPercent);
  const cumulativeRetention = retentionCap == null || requestedRetention < retentionCap
    ? requestedRetention
    : retentionCap;
  if (cumulativeRetention < priorRetention) {
    throw new Error("محتجزات المستخلص التراكمي أقل من آخر محتجزات معتمدة للعقد");
  }
  const currentGross = gross - priorGross;
  const retention = cumulativeRetention - priorRetention;
  const due = currentGross > retention ? currentGross - retention : 0n;
  const vat = multiplyCentsByPercent(due, percentCents(input.vatPercent));
  return {
    grossAmount: centsString(gross),
    cumulativeGrossAmount: centsString(gross),
    previousPaid: centsString(priorGross),
    priorGrossAmount: centsString(priorGross),
    currentGrossAmount: centsString(currentGross),
    currentPeriodGrossAmount: centsString(currentGross),
    retentionAmount: centsString(retention),
    dueAmount: centsString(due),
    vatAmount: centsString(vat),
    netAmount: centsString(due + vat),
  };
}

// Descriptive alias for callers that want to make the aggregate mode
// explicit at the call site.
export const calculateAggregateContractProgress = aggregateContractProgressAmounts;

/**
 * Return role-level lines before account mapping.  Keeping this role-level
 * makes the debit/credit math testable without manufacturing account IDs.
 */
export function contractingBillRoleLines(input: ContractingBillInput): AccountingRoleLine[] {
  const amount = contractingBillAmounts(input);
  const number = input.billNumber ?? "المستخلص";
  if (amount.period <= 0 && amount.vat <= 0 && amount.net <= 0 && amount.retention <= 0) {
    throw new Error("لا يمكن اعتماد مستخلص بمبالغ صفرية");
  }
  if (input.direction === "outgoing") {
    return [
      ...(amount.net > 0 ? [{ role: "receivable", debit: moneyValue(amount.net), credit: "0.00", description: `ذمم مستخلص ${number}` }] : []),
      ...(amount.retention > 0 ? [{ role: "retention_receivable", debit: moneyValue(amount.retention), credit: "0.00", description: `محتجزات مستخلص ${number}` }] : []),
      ...(amount.period > 0 ? [{ role: "revenue", debit: "0.00", credit: moneyValue(amount.period), description: `إيراد مستخلص ${number}` }] : []),
      ...(amount.vat > 0 ? [{ role: "vat_output", debit: "0.00", credit: moneyValue(amount.vat), description: `ضريبة مخرجات مستخلص ${number}` }] : []),
    ];
  }
  return [
    ...(amount.period > 0 ? [{ role: "wip", debit: moneyValue(amount.period), credit: "0.00", description: `أعمال تحت التنفيذ لمستخلص ${number}` }] : []),
    ...(amount.vat > 0 ? [{ role: "vat_input", debit: moneyValue(amount.vat), credit: "0.00", description: `ضريبة مدخلات مستخلص ${number}` }] : []),
    ...(amount.net > 0 ? [{ role: "payable", debit: "0.00", credit: moneyValue(amount.net), description: `مستحق مقاول باطن ${number}` }] : []),
    ...(amount.retention > 0 ? [{ role: "retention_payable", debit: "0.00", credit: moneyValue(amount.retention), description: `محتجزات مقاول باطن ${number}` }] : []),
  ];
}

export function reverseAccountingLines(lines: Array<{ debit: number | string; credit: number | string; description?: string | null }>) {
  return lines.map((line) => ({
    debit: moneyValue(numberValue(line.credit)),
    credit: moneyValue(numberValue(line.debit)),
    description: `عكس: ${line.description ?? ""}`.trim(),
  }));
}

export type SettlementCapInput = {
  kind: "advance_application" | "retention_receipt" | "retention_payment" | "bill_receipt" | "bill_payment";
  requested: number | string;
  availableAdvance?: number | string;
  retentionAmount?: number | string;
  alreadyReleased?: number | string;
  billNetAmount?: number | string;
  billPaidAmount?: number | string;
};

export function validateSettlementCap(input: SettlementCapInput):
  | { ok: true; remaining: number }
  | { ok: false; reason: string } {
  const requested = numberValue(input.requested);
  if (!(requested > 0)) return { ok: false, reason: "المبلغ يجب أن يكون أكبر من صفر" };

  let remaining: number;
  if (input.kind === "advance_application") {
    remaining = numberValue(input.availableAdvance);
    if (requested > remaining + 0.005) {
      return { ok: false, reason: "مبلغ التطبيق يتجاوز رصيد السلفة المتاح" };
    }
  } else if (input.kind === "retention_receipt" || input.kind === "retention_payment") {
    remaining = Math.max(0, numberValue(input.retentionAmount) - numberValue(input.alreadyReleased));
    if (requested > remaining + 0.005) {
      return { ok: false, reason: "مبلغ الإفراج عن المحتجزات يتجاوز الرصيد المتبقي للمستخلص" };
    }
  } else {
    remaining = Math.max(0, numberValue(input.billNetAmount) - numberValue(input.billPaidAmount));
    if (requested > remaining + 0.005) {
      return { ok: false, reason: "مبلغ التسوية يتجاوز رصيد المستخلص المتبقي" };
    }
  }
  return { ok: true, remaining: Math.round(remaining * 100) / 100 };
}

export function idempotencyDecision(key: string | null | undefined, existingKeys: Iterable<string>) {
  const normalized = String(key ?? "").trim();
  if (!normalized) return { ok: false as const, replay: false, reason: "مفتاح العملية مطلوب لمنع الترحيل المكرر" };
  const existing = new Set(existingKeys);
  if (existing.has(normalized)) return { ok: true as const, replay: true };
  return { ok: true as const, replay: false };
}

export type MaterialCostInput = {
  direction: "issue" | "return";
  qtyBase: number | string;
  unitCost: number | string;
  sourceQtyBase?: number | string;
  alreadyReturnedBase?: number | string;
};

export function materialMovementCost(input: MaterialCostInput):
  | { ok: true; qtyBase: number; unitCost: number; totalCost: number }
  | { ok: false; reason: string } {
  const qtyBase = numberValue(input.qtyBase);
  const unitCost = numberValue(input.unitCost);
  if (!(qtyBase > 0)) return { ok: false, reason: "الكمية يجب أن تكون أكبر من صفر" };
  if (!(unitCost > 0)) return { ok: false, reason: "لا توجد تكلفة فعلية موجبة في سجل المخزون لهذه الحركة" };
  if (input.direction === "return") {
    const sourceQty = numberValue(input.sourceQtyBase);
    const alreadyReturned = numberValue(input.alreadyReturnedBase);
    if (!(sourceQty > 0)) return { ok: false, reason: "حركة الصرف الأصلية غير موجودة" };
    if (alreadyReturned + qtyBase > sourceQty + 0.000001) {
      return { ok: false, reason: "كمية الإرجاع تتجاوز الكمية المصروفة من الحركة الأصلية" };
    }
  }
  return {
    ok: true,
    qtyBase,
    unitCost,
    totalCost: Math.round(qtyBase * unitCost * 100) / 100,
  };
}