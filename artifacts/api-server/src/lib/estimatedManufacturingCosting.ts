export type EstimatedManufacturingBasis =
  | "machine_hours"
  | "labor_hours"
  | "production_quantity"
  | "area"
  | "percentage"
  | "equal"
  | "manual";

export type EstimatedAllocationInput = {
  orderId: number;
  driverValue: number;
};

export type EstimatedAllocation = EstimatedAllocationInput & {
  allocatedAmount: number;
  sharePct: number;
};

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function requireFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`${label} يجب أن يكون صفراً أو موجباً`), { status: 400 });
  }
}

/**
 * Split one monthly estimate into immutable order shares. For measured drivers,
 * the manually entered denominator must reconcile to the month's order facts.
 * Percentage allocations are shares of the monthly pool and must total 100%.
 * Manual allocations are explicit amounts and must total the pool exactly.
 */
export function allocateEstimatedManufacturingPool(input: {
  estimatedAmount: number;
  basis: EstimatedManufacturingBasis;
  denominator: number | null;
  allocations: EstimatedAllocationInput[];
}): EstimatedAllocation[] {
  const estimatedAmount = money(input.estimatedAmount);
  requireFiniteNonNegative(estimatedAmount, "مبلغ التكلفة التقديرية");
  if (estimatedAmount <= 0) {
    throw Object.assign(new Error("مبلغ التكلفة التقديرية يجب أن يكون أكبر من صفر"), { status: 400 });
  }
  if (!input.allocations.length) {
    throw Object.assign(new Error("أضف أمراً واحداً على الأقل لتوزيع التكلفة"), { status: 400 });
  }
  const seenOrders = new Set<number>();
  for (const row of input.allocations) {
    if (!Number.isInteger(row.orderId) || row.orderId <= 0 || seenOrders.has(row.orderId)) {
      throw Object.assign(new Error("الأوامر الموزع عليها التكلفة غير صالحة أو مكررة"), { status: 400 });
    }
    seenOrders.add(row.orderId);
    requireFiniteNonNegative(row.driverValue, "قيمة أساس التوزيع");
  }

  const totalDriver = input.allocations.reduce((sum, row) => sum + row.driverValue, 0);
  const tolerance = 0.0001;

  if (input.basis === "percentage") {
    if (Math.abs(totalDriver - 100) > tolerance) {
      throw Object.assign(new Error("يجب أن يساوي مجموع نسب الأوامر 100%"), { status: 422 });
    }
  } else if (input.basis === "manual") {
    if (Math.abs(money(totalDriver) - estimatedAmount) > 0.01) {
      throw Object.assign(new Error("يجب أن يساوي مجموع التوزيعات اليدوية كامل المبلغ التقديري"), { status: 422 });
    }
  } else {
    const denominator = Number(input.denominator);
    if (!Number.isFinite(denominator) || denominator <= 0) {
      throw Object.assign(new Error("مقام التوزيع الشهري اليدوي يجب أن يكون أكبر من صفر"), { status: 422 });
    }
    if (input.basis === "equal" && input.allocations.some((row) => Math.abs(row.driverValue - 1) > tolerance)) {
      throw Object.assign(new Error("أساس التوزيع المتساوي يستخدم قيمة واحدة لكل أمر"), { status: 400 });
    }
    if (Math.abs(totalDriver - denominator) > Math.max(tolerance, denominator * 0.000001)) {
      throw Object.assign(new Error("مجموع أساسات الأوامر لا يطابق المقام الشهري المحفوظ"), { status: 422 });
    }
  }

  let allocated = 0;
  return input.allocations.map((row, index) => {
    const last = index === input.allocations.length - 1;
    let amount: number;
    let sharePct: number;
    if (input.basis === "manual") {
      amount = money(row.driverValue);
      sharePct = estimatedAmount > 0 ? Number((amount / estimatedAmount * 100).toFixed(6)) : 0;
    } else {
      sharePct = input.basis === "percentage"
        ? row.driverValue
        : Number((row.driverValue / totalDriver * 100).toFixed(6));
      amount = last
        ? money(estimatedAmount - allocated)
        : money(estimatedAmount * (sharePct / 100));
    }
    if (amount < 0 || amount > estimatedAmount + 0.01) {
      throw Object.assign(new Error("نتيجة توزيع التكلفة خارج حدود المجمع الشهري"), { status: 422 });
    }
    allocated = money(allocated + amount);
    return { ...row, allocatedAmount: amount, sharePct };
  });
}
