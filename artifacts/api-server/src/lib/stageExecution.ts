export const STAGE_WASTE_CLASSIFICATIONS = ["normal", "abnormal"] as const;
export type StageWasteClassification = typeof STAGE_WASTE_CLASSIFICATIONS[number];

export type StageExecutionPayload = {
  inputQty?: number;
  outputQty?: number;
  wasteQty?: number;
  actualDurationMinutes?: number;
  workerCount?: number | null;
  operatorUserId?: number | null;
  resourceId?: number | null;
  workCenterId?: number | null;
  wasteReason?: string | null;
  wasteType?: string | null;
  wasteClassification?: StageWasteClassification | null;
  notes?: string | null;
};

function nonNegative(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw Object.assign(new Error(`${field} يجب أن يكون رقماً موجباً أو صفراً`), { status: 400 });
  }
  return number;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw Object.assign(new Error(`${field} يجب أن يكون عدداً صحيحاً غير سالب`), { status: 400 });
  }
  return number;
}

function optionalId(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error(`${field} غير صحيح`), { status: 400 });
  }
  return id;
}

function optionalText(value: unknown, field: string, max = 2000): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${field} غير صحيح`), { status: 400 });
  }
  const text = value.trim();
  if (text.length > max) {
    throw Object.assign(new Error(`${field} يتجاوز الحد المسموح`), { status: 400 });
  }
  return text || null;
}

/**
 * Normalize operational stage facts without assigning a currency amount.
 * Actual minutes are persisted solely as a cost-driver input; the approved
 * source allocation engine owns all cost calculation and posting.
 */
export function normalizeStageExecutionPayload(
  value: unknown,
  options: { requireOutput?: boolean } = {},
): StageExecutionPayload {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  // A stage never owns an independently-entered expense. Reject these common
  // names instead of silently accepting a UI value that appears capitalized
  // but is not part of the approved source/settlement engine.
  for (const forbiddenCostField of ["costAmount", "stageCost", "actualCost", "amount"]) {
    if (forbiddenCostField in body) {
      throw Object.assign(
        new Error("زمن المرحلة محرك تكلفة فقط؛ لا يقبل تسجيل مبلغ تكلفة مستقل"),
        { status: 400 },
      );
    }
  }
  const result: StageExecutionPayload = {};
  if ("inputQty" in body) result.inputQty = nonNegative(body.inputQty, "كمية الإدخال");
  if ("outputQty" in body) result.outputQty = nonNegative(body.outputQty, "كمية الإخراج");
  if ("wasteQty" in body) result.wasteQty = nonNegative(body.wasteQty, "كمية الهالك");
  if (options.requireOutput && result.outputQty === undefined) {
    throw Object.assign(new Error("كمية الإخراج مطلوبة"), { status: 400 });
  }

  if ("actualDurationMinutes" in body || "actualMinutes" in body || "actualHours" in body) {
    const minutes = "actualDurationMinutes" in body
      ? body.actualDurationMinutes
      : "actualMinutes" in body
        ? body.actualMinutes
        : Number(body.actualHours) * 60;
    result.actualDurationMinutes = nonNegative(minutes, "مدة التنفيذ بالدقائق");
  }
  if ("workerCount" in body) {
    result.workerCount = optionalNonNegativeInteger(body.workerCount, "عدد العمال");
  }
  if ("operatorUserId" in body || "workerUserId" in body) {
    result.operatorUserId = optionalId(
      "operatorUserId" in body ? body.operatorUserId : body.workerUserId,
      "العامل",
    );
  }
  if ("resourceId" in body || "machineId" in body) {
    result.resourceId = optionalId(
      "resourceId" in body ? body.resourceId : body.machineId,
      "الآلة",
    );
  }
  if ("workCenterId" in body) {
    result.workCenterId = optionalId(body.workCenterId, "مركز العمل");
  }
  if ("wasteReason" in body) result.wasteReason = optionalText(body.wasteReason, "سبب الهالك");
  if ("wasteType" in body) result.wasteType = optionalText(body.wasteType, "نوع الهالك", 100);
  if ("wasteClassification" in body) {
    const classification = optionalText(body.wasteClassification, "تصنيف الهالك", 20);
    if (classification !== null &&
        !(STAGE_WASTE_CLASSIFICATIONS as readonly string[]).includes(classification)) {
      throw Object.assign(new Error("تصنيف الهالك يجب أن يكون normal أو abnormal"), { status: 400 });
    }
    result.wasteClassification = classification as StageWasteClassification | null;
  }
  if ("notes" in body) result.notes = optionalText(body.notes, "ملاحظات المرحلة");
  return result;
}