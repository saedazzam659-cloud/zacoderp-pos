export class SupplierBulkAccountPlanError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SupplierBulkAccountPlanError";
  }
}

/**
 * Build deterministic numeric child codes for the supplier bulk-linking tool.
 *
 * `leadingZeros` means the number of zeroes shown before the first sequence
 * number. Example: parent 21012 + two zeroes => 001, 002 ... 100, producing
 * 21012001, 21012002 ... 21012100.
 */
export function buildSupplierBulkAccountCodes(
  parentCodeRaw: string,
  leadingZeros: number,
  count: number,
): string[] {
  const parentCode = String(parentCodeRaw ?? "").trim();
  if (!/^\d+$/.test(parentCode)) {
    throw new SupplierBulkAccountPlanError("يجب أن يكون رقم الحساب الرئيسي رقمياً");
  }
  if (!Number.isInteger(leadingZeros) || leadingZeros < 0 || leadingZeros > 5) {
    throw new SupplierBulkAccountPlanError("عدد الأصفار يجب أن يكون من 0 إلى 5");
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new SupplierBulkAccountPlanError("يجب تحديد مورد واحد على الأقل");
  }

  const sequenceWidth = leadingZeros + 1;
  const maxSequence = (10 ** sequenceWidth) - 1;
  if (count > maxSequence) {
    throw new SupplierBulkAccountPlanError(
      `عدد الموردين أكبر من سعة الترقيم الحالية (${maxSequence}) — زِد عدد الأصفار`,
    );
  }

  return Array.from(
    { length: count },
    (_, index) => `${parentCode}${String(index + 1).padStart(sequenceWidth, "0")}`,
  );
}