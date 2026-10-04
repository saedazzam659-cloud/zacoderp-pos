import {
  decimalForStorage,
  isPositiveExactDecimal,
  multiplyQuantity,
} from "./unitConversion.js";

export class BundleComponentQuantityError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BundleComponentQuantityError";
  }
}

/**
 * Convert a quantity entered in one of the child's configured units into its
 * base inventory unit. The stored bundle recipe remains canonical so existing
 * assembly, costing, and stock flows continue to read the same qty column.
 */
export function normalizeBundleComponentQuantity(input: {
  qty: unknown;
  unitId: number | null;
  baseUnitId: number | null;
  unitFactors: ReadonlyMap<number, string>;
}): string {
  const qty = typeof input.qty === "string" ? input.qty.trim() : String(input.qty ?? "");
  if (!isPositiveExactDecimal(qty)) {
    throw new BundleComponentQuantityError("الكمية يجب أن تكون رقماً موجباً", "INVALID_QTY");
  }

  let factor = "1";
  if (input.unitId === null) {
    if (input.baseUnitId !== null) {
      throw new BundleComponentQuantityError("اختر وحدة قياس الصنف", "UNIT_REQUIRED");
    }
  } else if (input.baseUnitId === null) {
    throw new BundleComponentQuantityError("الصنف لا يملك وحدة أساسية صالحة", "BASE_UNIT_REQUIRED");
  } else if (input.unitId !== input.baseUnitId) {
    const configuredFactor = input.unitFactors.get(input.unitId);
    if (!configuredFactor || !isPositiveExactDecimal(configuredFactor)) {
      throw new BundleComponentQuantityError("وحدة القياس غير مرتبطة بهذا الصنف أو غير صالحة", "INVALID_UNIT");
    }
    factor = configuredFactor;
  }

  const baseQty = decimalForStorage(multiplyQuantity(qty, factor), 4, "half_up");
  if (!isPositiveExactDecimal(baseQty)) {
    throw new BundleComponentQuantityError("الكمية أقل من دقة المخزون المسموح بها", "QTY_TOO_SMALL");
  }
  return baseQty;
}