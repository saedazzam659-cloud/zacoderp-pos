export type ResourceCostAllocation = {
  id: number;
  sourceType: string;
  sourceRecordId: number;
  snapshotMeta?: Record<string, unknown> | null;
};

function included(meta: Record<string, unknown>) {
  return meta.includeInManufacturing !== false;
}

/**
 * Electricity is settled through an existing posted industrial purchase source,
 * never through the machine tariff estimate. Keep this predicate deliberately
 * narrow so a generic overhead, a return, or an unapproved allocation cannot
 * become an electricity settlement source.
 */
export function isMachineElectricityAllocation(
  allocation: ResourceCostAllocation,
): boolean {
  const meta = allocation.snapshotMeta ?? {};
  return allocation.sourceType === "purchase_invoice" &&
    included(meta) &&
    meta.costType === "electricity" &&
    (meta.industrialDriver ?? meta.allocationMethod) === "machine_hours";
}

export function requireSingleMachineElectricityAllocation(
  allocations: ResourceCostAllocation[],
): ResourceCostAllocation {
  const matches = allocations.filter(isMachineElectricityAllocation);
  if (matches.length !== 1) {
    throw Object.assign(
      new Error(
        "كهرباء الآلة تحتاج مصدر فاتورة كهرباء صناعية مرحّلاً واحداً " +
        "وموزعاً على الأمر بمحرك ساعات الآلة",
      ),
      { status: 422, code: "MACHINE_ELECTRICITY_SOURCE_REQUIRED" },
    );
  }
  return matches[0];
}

export function machineElectricityEstimate(
  kw: number,
  hours: number,
  tariffPerKwh: number,
): { kwh: number; amount: number } {
  if (![kw, hours, tariffPerKwh].every(Number.isFinite) ||
      !(kw > 0) || !(hours >= 0) || !(tariffPerKwh > 0)) {
    throw Object.assign(
      new Error("كهرباء الآلة مفعلة لكن قدرة kW أو ساعات التشغيل أو تعريفة kWh غير معتمدة"),
      { status: 422 },
    );
  }
  const kwh = Number((kw * hours).toFixed(6));
  return { kwh, amount: Number((kwh * tariffPerKwh).toFixed(2)) };
}

/** Actual source cost less the provisional tariff accrual already in WIP/FG. */
export function settleProvisionalResourceCost(actualAmount: number, accruedAmount: number) {
  if (![actualAmount, accruedAmount].every((value) => Number.isFinite(value) && value >= 0)) {
    throw Object.assign(new Error("مبلغ المصدر الفعلي أو الاستحقاق المؤقت غير صالح"), { status: 422 });
  }
  const actual = Number(actualAmount.toFixed(2));
  const accrued = Number(accruedAmount.toFixed(2));
  return {
    actualAmount: actual,
    accruedAmount: accrued,
    deltaAmount: Number((actual - accrued).toFixed(2)),
  };
}

export function provisionalResourceReceiptBalance(materialWip: number, resourceAccrual: number) {
  if (![materialWip, resourceAccrual].every((value) => Number.isFinite(value) && value >= 0)) {
    throw Object.assign(new Error("رصيد WIP أو استحقاق المورد غير صالح"), { status: 422 });
  }
  return Number((materialWip + resourceAccrual).toFixed(2));
}

/** Split an actual-vs-accrued utility delta by the immutable original receipt. */
export function splitProvisionalResourceSettlement(
  actualAmount: number,
  accruedAmount: number,
  finishedGoodsReceiptAmount: number,
  abnormalWasteReceiptAmount: number,
) {
  const base = provisionalResourceReceiptBalance(
    finishedGoodsReceiptAmount, abnormalWasteReceiptAmount,
  );
  const settlement = settleProvisionalResourceCost(actualAmount, accruedAmount);
  if (!(base > 0)) {
    throw Object.assign(new Error("توزيع استلام البضاعة التامة/الهالك الأصلي غير صالح"), { status: 422 });
  }
  const finishedGoodsDelta = Number((settlement.deltaAmount * finishedGoodsReceiptAmount / base).toFixed(2));
  return {
    ...settlement,
    finishedGoodsDelta,
    abnormalWasteDelta: Number((settlement.deltaAmount - finishedGoodsDelta).toFixed(2)),
  };
}