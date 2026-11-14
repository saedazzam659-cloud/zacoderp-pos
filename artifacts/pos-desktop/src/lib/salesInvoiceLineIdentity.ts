export interface SalesInvoiceLineIdentity {
  itemId: number;
  brandId?: number | null;
}

export function findDuplicateSalesInvoiceLineIndex<T extends SalesInvoiceLineIdentity>(
  lines: readonly T[],
  itemId: number,
  brandId: number | null,
  excludedIndex = -1,
): number {
  return lines.findIndex((line, index) =>
    index !== excludedIndex &&
    Number(line.itemId) === Number(itemId) &&
    (line.brandId ?? null) === (brandId ?? null),
  );
}
