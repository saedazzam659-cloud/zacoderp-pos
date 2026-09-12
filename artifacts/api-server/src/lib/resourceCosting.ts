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