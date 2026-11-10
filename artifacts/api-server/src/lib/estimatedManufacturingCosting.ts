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

export type ActualDriverAllocationInput = {
  orderId: number;
  plannedDriverValue: number | null;
  actualDriverValue: number;
};

export type ActualDriverAllocation = ActualDriverAllocationInput & {
  appliedAmount: number;
  sharePct: number;
  usageVarianceDriver: number | null;
  usageVarianceAmount: number | null;
};

export type EstimatedStageDriverFact = {
  orderId: number;
  stageId: number;
  stageName: string;
  status: string;
  resourceMode: string | null;
  actualDurationMinutes: number | null;
  expectedDurationMinutes: number | null;
  workerCount: number | null;
  workerEmployeeIds: number[] | null;
  completedAt: Date | string | null;
};

export type EstimatedOrderStageDriverSummary = {
  orderId: number;
  plannedDriverValue: number | null;
  actualDriverValue: number;
  stages: Array<{
    stageId: number;
    stageName: string;
    plannedDriverValue: number | null;
    actualDriverValue: number;
    actualDurationMinutes: number;
    workerCount: number | null;
  }>;
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

/**
 * Apply a frozen monthly hourly rate to actual stage drivers. Unlike the
 * planned allocation helper above, actual hours may exceed the monthly
 * denominator: the saved rate is not recalculated for overtime or volume.
 */
export function allocateEstimatedManufacturingPoolByActualDriver(input: {
  estimatedAmount: number;
  denominator: number;
  allocations: ActualDriverAllocationInput[];
}): {
  rate: number;
  plannedDriverTotal: number;
  actualDriverTotal: number;
  plannedAppliedAmount: number;
  appliedAmount: number;
  usageVarianceDriver: number | null;
  usageVarianceAmount: number | null;
  rows: ActualDriverAllocation[];
} {
  const estimatedAmount = money(input.estimatedAmount);
  const denominator = Number(input.denominator);
  requireFiniteNonNegative(estimatedAmount, "مبلغ التكلفة التقديرية");
  if (estimatedAmount <= 0) {
    throw Object.assign(new Error("مبلغ التكلفة التقديرية يجب أن يكون أكبر من صفر"), { status: 400 });
  }
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw Object.assign(new Error("مقام التوزيع الشهري يجب أن يكون أكبر من صفر"), { status: 422 });
  }
  const seenOrders = new Set<number>();
  for (const row of input.allocations) {
    if (!Number.isInteger(row.orderId) || row.orderId <= 0 || seenOrders.has(row.orderId)) {
      throw Object.assign(new Error("أوامر محرك التكلفة غير صالحة أو مكررة"), { status: 400 });
    }
    seenOrders.add(row.orderId);
    requireFiniteNonNegative(row.actualDriverValue, "قيمة المحرك الفعلية");
    if (row.plannedDriverValue != null) {
      requireFiniteNonNegative(row.plannedDriverValue, "قيمة المحرك التقديرية");
    }
  }

  const rate = estimatedAmount / denominator;
  const plannedRows = input.allocations.filter((row) => row.plannedDriverValue != null);
  const plannedDriverTotal = plannedRows.reduce(
    (sum, row) => sum + Number(row.plannedDriverValue), 0,
  );
  const actualDriverTotal = input.allocations.reduce(
    (sum, row) => sum + row.actualDriverValue, 0,
  );
  const plannedAppliedAmount = money(rate * plannedDriverTotal);
  const appliedAmount = money(rate * actualDriverTotal);
  const usageVarianceDriver = plannedRows.length === input.allocations.length
    ? Number((actualDriverTotal - plannedDriverTotal).toFixed(6))
    : null;
  const usageVarianceAmount = usageVarianceDriver == null
    ? null
    : money(rate * usageVarianceDriver);
  let assignedApplied = 0;
  const nonZeroRows = input.allocations
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.actualDriverValue > 0);
  const lastNonZeroIndex = nonZeroRows.at(-1)?.index ?? -1;
  const rows = input.allocations.map((row, index) => {
    const rowApplied = index === lastNonZeroIndex
      ? money(appliedAmount - assignedApplied)
      : money(rate * row.actualDriverValue);
    assignedApplied = money(assignedApplied + rowApplied);
    const usageVarianceDriver = row.plannedDriverValue == null
      ? null
      : Number((row.actualDriverValue - row.plannedDriverValue).toFixed(6));
    return {
      ...row,
      appliedAmount: rowApplied,
      sharePct: actualDriverTotal > 0
        ? Number((row.actualDriverValue / actualDriverTotal * 100).toFixed(6))
        : 0,
      usageVarianceDriver,
      usageVarianceAmount: usageVarianceDriver == null
        ? null
        : money(rate * usageVarianceDriver),
    };
  });
  return {
    rate,
    plannedDriverTotal,
    actualDriverTotal,
    plannedAppliedAmount,
    appliedAmount,
    usageVarianceDriver,
    usageVarianceAmount,
    rows,
  };
}

/**
 * Aggregate the completed stages assigned to one monthly pool. A stage's
 * actual duration is attributed to its completion month; labor hours are
 * person-hours (stage duration for each recorded worker).
 */
export function summarizeEstimatedStageDrivers(
  basis: "machine_hours" | "labor_hours",
  period: string,
  stages: EstimatedStageDriverFact[],
): Map<number, EstimatedOrderStageDriverSummary> {
  const result = new Map<number, EstimatedOrderStageDriverSummary>();
  for (const stage of stages) {
    if (stage.status !== "done" || !stage.completedAt) continue;
    const completedAt = stage.completedAt instanceof Date
      ? stage.completedAt.toISOString()
      : String(stage.completedAt);
    if (completedAt.slice(0, 7) !== period) continue;
    const mode = stage.resourceMode ?? "labor";
    if (basis === "machine_hours" && mode !== "machine" && mode !== "both") continue;
    if (basis === "labor_hours" && mode !== "labor" && mode !== "both") continue;

    const minutes = Number(stage.actualDurationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw Object.assign(
        new Error(`مدة التنفيذ الفعلية غير مسجلة للمرحلة ${stage.stageName || stage.stageId}`),
        { status: 409 },
      );
    }
    const workers = Number(stage.workerCount);
    if (basis === "labor_hours" && (!Number.isInteger(workers) || workers <= 0)) {
      throw Object.assign(
        new Error(`عدد العمال الفعلي غير مسجل للمرحلة ${stage.stageName || stage.stageId}`),
        { status: 409 },
      );
    }
    const employeeIds = Array.isArray(stage.workerEmployeeIds)
      ? [...new Set(stage.workerEmployeeIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
      : [];
    if (basis === "labor_hours" && employeeIds.length > 0 && employeeIds.length !== workers) {
      throw Object.assign(
        new Error(`عدد العمال لا يطابق قائمة الموظفين في المرحلة ${stage.stageName || stage.stageId}`),
        { status: 409 },
      );
    }

    const multiplier = basis === "labor_hours" ? workers : 1;
    const actualDriverValue = Number((minutes / 60 * multiplier).toFixed(6));
    const expectedMinutes = stage.expectedDurationMinutes == null
      ? null : Number(stage.expectedDurationMinutes);
    const plannedDriverValue = expectedMinutes == null
      ? null
      : Number((expectedMinutes / 60 * multiplier).toFixed(6));
    const current = result.get(stage.orderId) ?? {
      orderId: stage.orderId,
      plannedDriverValue: 0,
      actualDriverValue: 0,
      stages: [],
    };
    if (current.plannedDriverValue != null) {
      if (plannedDriverValue == null) current.plannedDriverValue = null;
      else current.plannedDriverValue = Number(
        (current.plannedDriverValue + plannedDriverValue).toFixed(6),
      );
    }
    current.actualDriverValue = Number((current.actualDriverValue + actualDriverValue).toFixed(6));
    current.stages.push({
      stageId: stage.stageId,
      stageName: stage.stageName,
      plannedDriverValue,
      actualDriverValue,
      actualDurationMinutes: minutes,
      workerCount: stage.workerCount,
    });
    result.set(stage.orderId, current);
  }
  return result;
}
