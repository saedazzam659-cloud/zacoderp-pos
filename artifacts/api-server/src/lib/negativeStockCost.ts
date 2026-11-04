export type NegativeStockLayerCandidate = {
  id: number;
  quantity: string | number;
};

export function planNegativeStockCoverage(
  layers: NegativeStockLayerCandidate[],
  receiptQuantity: number,
): Array<{ layerId: number; quantity: number }> {
  let remaining = Math.max(0, receiptQuantity);
  const allocations: Array<{ layerId: number; quantity: number }> = [];
  for (const layer of layers) {
    if (remaining <= 0.0001) break;
    const available = Math.max(0, Number(layer.quantity) || 0);
    const quantity = Math.min(available, remaining);
    if (quantity <= 0.0001) continue;
    allocations.push({ layerId: layer.id, quantity });
    remaining -= quantity;
  }
  return allocations;
}

export function negativeStockCostAdjustment(
  provisionalUnitCost: number,
  actualUnitCost: number,
  coveredQuantity: number,
): number {
  return Number(((actualUnitCost - provisionalUnitCost) * coveredQuantity).toFixed(2));
}

export function returnCostAdjustmentPerUnit(
  totalAdjustment: number,
  soldQuantity: number,
): number {
  return soldQuantity > 0 ? totalAdjustment / soldQuantity : 0;
}
