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
 * and `priorRetentionAmount` are maxima of certified bills for the locked
 * contract, not paid amounts and not client-supplied `previousPaid`.
 */
export function authoritativeCumulativeBillAmounts(input: {
  grossAmount: number | string;
  retentionPercent: number | string;
  vatPercent: number | string;
  priorGrossAmount: number | string;
  priorRetentionAmount: number | string;
}) {
  const gross = scaledCents(input.grossAmount);
  const priorGross = scaledCents(input.priorGrossAmount);
  const currentRetention = multiplyCentsByPercent(gross, percentCents(input.retentionPercent));
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