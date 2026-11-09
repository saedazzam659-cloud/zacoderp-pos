export interface StockBalanceCostRow {
  qty: number | string | null | undefined;
  avgCost: number | string | null | undefined;
}

export function averageCostFromInventoryValue(
  quantity: number,
  inventoryValue: number,
  zeroQuantityFallback = 0,
): number {
  return quantity !== 0 ? inventoryValue / quantity : zeroQuantityFallback;
}

export function summarizeStockBalances(rows: readonly StockBalanceCostRow[]) {
  const quantity = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
  const inventoryValue = rows.reduce(
    (sum, row) => sum + Number(row.qty ?? 0) * Number(row.avgCost ?? 0),
    0,
  );
  const zeroQuantityFallback = rows.length === 1 ? Number(rows[0].avgCost ?? 0) : 0;

  return {
    quantity,
    inventoryValue,
    avgCost: averageCostFromInventoryValue(quantity, inventoryValue, zeroQuantityFallback),
  };
}
