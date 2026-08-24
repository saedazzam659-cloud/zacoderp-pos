export interface SupplierBulkSelectable {
  id: number;
}

export function suppliersInStableGridOrder<T extends SupplierBulkSelectable>(
  suppliers: readonly T[],
): T[] {
  return [...suppliers].sort((a, b) => a.id - b.id);
}

export function selectedSuppliersInGridOrder<T extends SupplierBulkSelectable>(
  suppliersInGridOrder: readonly T[],
  selectedIds: ReadonlySet<number | string>,
): T[] {
  return suppliersInGridOrder.filter((supplier) => selectedIds.has(supplier.id));
}

export function buildSupplierBulkPreview<T extends SupplierBulkSelectable>(
  selectedSuppliers: readonly T[],
  parentCode: string,
  leadingZeros: number,
): Array<{ supplier: T; accountCode: string }> {
  const normalizedParentCode = parentCode.trim();
  if (
    !/^\d+$/.test(normalizedParentCode)
    || !Number.isInteger(leadingZeros)
    || leadingZeros < 0
    || leadingZeros > 5
  ) {
    return [];
  }

  return selectedSuppliers.map((supplier, index) => ({
    supplier,
    accountCode: `${normalizedParentCode}${String(index + 1).padStart(leadingZeros + 1, "0")}`,
  }));
}