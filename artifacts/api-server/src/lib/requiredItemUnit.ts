/** No default unit may be invented for an item. Existing/parent units may
 * only be retained when the caller omitted the field, not when clearing it. */
export function requireItemUnit(value: unknown, retained?: unknown): number {
  const candidate = value === undefined ? retained : value;
  if ((typeof candidate !== "number" && typeof candidate !== "string")
    || !Number.isSafeInteger(Number(candidate)) || Number(candidate) <= 0) {
    throw new Error("الوحدة الأساسية للصنف مطلوبة؛ اختر وحدة قياس صحيحة قبل الحفظ.");
  }
  return Number(candidate);
}