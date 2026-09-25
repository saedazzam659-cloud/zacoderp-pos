/**
 * Pure BOQ certification math.
 *
 * Quantities describe physical execution.  Certified values describe the
 * amount that can be billed.  Keeping this calculation free of database and
 * request concerns lets draft edits and approval-time re-certification use
 * exactly the same rules.
 */

export type PendingCertificationAllocation = {
  sourceLineId: number;
  amount: string;
};
export type QuotedBoqComponent = { unitPrice: number | string; vatPercent: number | string; priceIncludesVat: boolean };

export type CertificationPriorLine = {
  id: number;
  currentQty?: number | string | null;
  executionValue?: number | string | null;
  currentExecutionCertifiedValue?: number | string | null;
  currentValue?: number | string | null;
  pendingCertificationAllocations?: unknown;
  quotedUnitPriceSnapshot?: number | string | null;
  quotedVatPercentSnapshot?: number | string | null;
  quotedPriceIncludesVatSnapshot?: boolean | null;
  quotedPriceComponentsSnapshot?: QuotedBoqComponent[] | unknown;
};

export type BoqCertificationInput = {
  currentQty: number | string | null | undefined;
  unitPrice: number | string | null | undefined;
  quotedUnitPrice?: number | string | null;
  quotedVatPercent?: number | string | null;
  quotedPriceIncludesVat?: boolean;
  quotedPriceComponents?: QuotedBoqComponent[] | null;
  /** Effective BOQ quantity after the selected approved variation. */
  contractQuantity?: number | string | null;
  certificationPercent?: number | string | null;
  priorPendingCertifiedValue?: number | string | null;
  certificationReason?: string | null;
  priorLines?: CertificationPriorLine[];
};

export type BoqCertificationResult = {
  executionValue: string;
  certificationPercent: string;
  currentExecutionCertifiedValue: string;
  priorPendingCertifiedValue: string;
  currentValue: string;
  pendingCertificationAllocations: PendingCertificationAllocation[];
  previousPendingValue: string;
  pendingValue: string;
};

const EPSILON_CENTS = 0.000001;

function finite(value: unknown, label: string): number {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} مطلوب`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} يجب أن يكون رقماً صالحاً`);
  return parsed;
}

function cents(value: unknown, label: string): number {
  const parsed = finite(value, label);
  return Math.round((parsed + Number.EPSILON) * 100);
}

function moneyFromCents(value: number): string {
  return (value / 100).toFixed(2);
}

/** Extract VAT once from the extended quoted line, never from rounded net
 * unit × quantity. Four decimal quantity and two decimal rate/price mirrors
 * the persisted BOQ precision; BigInt avoids intermediate floating drift. */
export function quotedBoqNetValue(qty: number | string, quotedUnitPrice: number | string, vatPercent: number | string, inclusive: boolean): string {
  const q = quantity(qty);
  if (Math.abs(q * 10000 - Math.round(q * 10000)) > 0.00001) throw new Error("دقة كمية BOQ لا تتجاوز أربع خانات");
  const unit = cents(quotedUnitPrice, "quoted unit price");
  const rate = cents(vatPercent, "VAT rate");
  if (rate < 0 || rate > 10000) throw new Error("نسبة الضريبة غير صالحة");
  const numerator = BigInt(Math.round(q * 10000)) * BigInt(Math.abs(unit)) * 10000n;
  const denominator = 10000n * BigInt(inclusive ? 10000 + rate : 10000);
  return moneyFromCents(Math.sign(unit) * Number((numerator + denominator / 2n) / denominator));
}

export function quotedBoqComponentsNet(qty: number | string, components: QuotedBoqComponent[]): string {
  if (!Array.isArray(components) || components.length === 0) throw new Error("تسعير BOQ غير صالح");
  const amount = components.reduce((sum, item) =>
    sum + cents(quotedBoqNetValue(qty, item.unitPrice, item.vatPercent, item.priceIncludesVat), "component net"), 0);
  if (amount < 0) throw new Error("قيمة BOQ بعد أمر التغيير لا يمكن أن تكون سالبة");
  return moneyFromCents(amount);
}

function quantity(value: unknown): number {
  const parsed = value == null || value === "" ? 0 : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("الكمية الحالية يجب أن تكون رقماً غير سالب");
  }
  return parsed;
}

function allocations(value: unknown): PendingCertificationAllocation[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("توزيعات الاعتماد المحتجز يجب أن تكون مصفوفة");
  return value.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    const sourceLineId = Number(candidate?.sourceLineId);
    if (!Number.isInteger(sourceLineId) || sourceLineId <= 0) {
      throw new Error("مصدر توزيع الاعتماد المحتجز غير صالح");
    }
    const amountCents = cents(candidate?.amount, "pending certification allocation amount");
    if (amountCents <= 0) throw new Error("قيمة توزيع الاعتماد المحتجز يجب أن تكون أكبر من صفر");
    return { sourceLineId, amount: moneyFromCents(amountCents) };
  });
}

function executionCents(line: CertificationPriorLine): number {
  // Null extension fields are the legacy fully-certified representation.
  return cents(
    line.executionValue == null ? line.currentValue ?? 0 : line.executionValue,
    "قيمة التنفيذ",
  );
}

function certifiedExecutionCents(line: CertificationPriorLine): number {
  return cents(
    line.currentExecutionCertifiedValue == null
      ? line.currentValue ?? line.executionValue ?? 0
      : line.currentExecutionCertifiedValue,
    "قيمة التنفيذ المعتمدة",
  );
}

function releasedBySource(priorLines: CertificationPriorLine[]): Map<number, number> {
  const knownIds = new Set(priorLines.map((line) => line.id));
  const released = new Map<number, number>();
  for (const line of priorLines) {
    for (const allocation of allocations(line.pendingCertificationAllocations)) {
      // A release is only valid against a certified earlier source line. A
      // malformed historical reference must not silently create value.
      if (!knownIds.has(allocation.sourceLineId)) {
        throw new Error("مصدر توزيع الاعتماد المحتجز خارج سجل BOQ المعتمد");
      }
      const amount = cents(allocation.amount, "pending certification allocation amount");
      released.set(allocation.sourceLineId, (released.get(allocation.sourceLineId) ?? 0) + amount);
    }
  }
  return released;
}

export function pendingValueForBoqLines(priorLines: CertificationPriorLine[] = []): number {
  const released = releasedBySource(priorLines);
  const totalCents = priorLines.reduce((total, line) => {
    const pending = executionCents(line) - certifiedExecutionCents(line)
      - (released.get(line.id) ?? 0);
    if (pending < -EPSILON_CENTS) {
      throw new Error("تم إطلاق قيمة التنفيذ المعتمدة أكثر من مرة");
    }
    return total + Math.max(0, pending);
  }, 0);
  return totalCents / 100;
}

/**
 * Calculate one line and allocate any release against earlier pending source
 * lines in FIFO order.
 */
export function calculateBoqCertification(
  input: BoqCertificationInput,
): BoqCertificationResult {
  const currentQty = quantity(input.currentQty);
  const unitPriceCents = cents(input.unitPrice ?? 0, "unit price");
  if (unitPriceCents < 0) throw new Error("سعر الوحدة يجب أن يكون غير سالب");
  if (input.contractQuantity != null && input.contractQuantity !== "") {
    const contractQuantity = finite(input.contractQuantity, "contract quantity");
    if (contractQuantity < 0) throw new Error("كمية العقد يجب أن تكون غير سالبة");
    const priorQty = (input.priorLines ?? []).reduce(
      (sum, line) => sum + quantity(line.currentQty),
      0,
    );
    if (priorQty + currentQty > contractQuantity + 0.0001) {
      throw new Error("الكمية تتجاوز كمية BOQ المعتمدة");
    }
  }

  const percent = input.certificationPercent == null || input.certificationPercent === ""
    ? 100
    : finite(input.certificationPercent, "نسبة الاعتماد");
  if (percent < 0 || percent > 100) {
    throw new Error("نسبة الاعتماد يجب أن تكون بين 0 و100");
  }

  const priorPendingCents = input.priorPendingCertifiedValue == null
    || input.priorPendingCertifiedValue === ""
    ? 0
    : cents(input.priorPendingCertifiedValue, "قيمة الاعتماد المحتجز السابق");
  if (priorPendingCents < 0) {
    throw new Error("قيمة الاعتماد المحتجز السابق يجب أن تكون غير سالبة");
  }

  const reason = input.certificationReason == null ? "" : String(input.certificationReason).trim();
  if (((currentQty > 0 && percent < 100 - EPSILON_CENTS) || priorPendingCents > 0) && !reason) {
    throw new Error("سبب الاعتماد مطلوب للاعتماد الجزئي أو إطلاق المحتجز");
  }

  const priorLines = input.priorLines ?? [];
  const released = releasedBySource(priorLines);
  const previousPendingCents = Math.round(pendingValueForBoqLines(priorLines) * 100);
  let remainingRelease = priorPendingCents;
  const pendingCertificationAllocations: PendingCertificationAllocation[] = [];

  for (const source of priorLines) {
    if (remainingRelease <= 0) break;
    const available = Math.max(
      0,
      executionCents(source)
        - certifiedExecutionCents(source)
        - (released.get(source.id) ?? 0),
    );
    if (available <= 0) continue;
    const amount = Math.min(available, remainingRelease);
    pendingCertificationAllocations.push({
      sourceLineId: source.id,
      amount: moneyFromCents(amount),
    });
    remainingRelease -= amount;
  }
  if (remainingRelease > EPSILON_CENTS) {
    throw new Error("قيمة الاعتماد المحتجز السابق تتجاوز الرصيد المحتجز المتاح");
  }

  const quoteComponents = input.quotedPriceComponents;
  const sameComponents = quoteComponents?.length && priorLines.every(line =>
    JSON.stringify(line.quotedPriceComponentsSnapshot) === JSON.stringify(quoteComponents));
  const sameQuote = input.quotedPriceIncludesVat === true && input.quotedUnitPrice != null
    && input.quotedVatPercent != null
    && priorLines.every(line =>
      line.quotedPriceIncludesVatSnapshot === true
      && Number(line.quotedUnitPriceSnapshot) === Number(input.quotedUnitPrice)
      && Number(line.quotedVatPercentSnapshot) === Number(input.quotedVatPercent));
  const priorExecution = priorLines.reduce((sum, line) => sum + executionCents(line), 0);
  const cumulativeQty = priorLines.reduce((sum, line) => sum + quantity(line.currentQty), currentQty);
  const cumulativeNet = sameComponents || sameQuote
    ? cents(quoteComponents?.length
      ? quotedBoqComponentsNet(cumulativeQty, quoteComponents)
      : quotedBoqNetValue(cumulativeQty, input.quotedUnitPrice!, input.quotedVatPercent!, true), "cumulative net")
      - priorExecution
    : null;
  const executionCentsValue = cumulativeNet != null && cumulativeNet >= 0
    ? cumulativeNet
    : quoteComponents?.length
      ? cents(quotedBoqComponentsNet(currentQty, quoteComponents), "extended components net")
      : input.quotedPriceIncludesVat === true && input.quotedUnitPrice != null && input.quotedVatPercent != null
      ? cents(quotedBoqNetValue(currentQty, input.quotedUnitPrice, input.quotedVatPercent, true), "extended net")
      : Math.round(currentQty * unitPriceCents);
  const currentCertifiedCents = Math.round(executionCentsValue * percent / 100);
  const currentValueCents = currentCertifiedCents + priorPendingCents;
  const pendingCents = previousPendingCents
    + executionCentsValue - currentCertifiedCents - priorPendingCents;
  if (pendingCents < -EPSILON_CENTS) {
    throw new Error("قيمة الاعتماد المحتجز لا يمكن أن تكون سالبة");
  }

  return {
    executionValue: moneyFromCents(executionCentsValue),
    certificationPercent: percent.toFixed(2),
    currentExecutionCertifiedValue: moneyFromCents(currentCertifiedCents),
    priorPendingCertifiedValue: moneyFromCents(priorPendingCents),
    currentValue: moneyFromCents(currentValueCents),
    pendingCertificationAllocations,
    previousPendingValue: moneyFromCents(previousPendingCents),
    pendingValue: moneyFromCents(Math.max(0, pendingCents)),
  };
}