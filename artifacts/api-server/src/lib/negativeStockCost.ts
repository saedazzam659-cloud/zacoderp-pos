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

export type NegativeStockCostSource = "stock_average" | "last_purchase" | "item_card" | "missing";

export function shouldRejectUncostedNegativeStock(
  enforcementEnabled: boolean,
  hasUncostedShortage: boolean,
): boolean {
  return enforcementEnabled && hasUncostedShortage;
}

export function resolveNegativeStockUnitCost(input: {
  costMethod: string;
  averageCost: number;
  lastPurchaseCost: number;
  itemCardCost: number;
  batchTracked: boolean;
}): { unitCost: number; source: NegativeStockCostSource } {
  const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
  const averageCost = positive(input.averageCost);

  // A weighted-average item without batch tracking can use its live inventory
  // average. Batch shortages have no remaining lot to price, so use purchase
  // history instead. last_cost items also deliberately prefer that history.
  if (!input.batchTracked && input.costMethod !== "last_cost" && averageCost > 0) {
    return { unitCost: averageCost, source: "stock_average" };
  }

  const lastPurchaseCost = positive(input.lastPurchaseCost);
  if (lastPurchaseCost > 0) return { unitCost: lastPurchaseCost, source: "last_purchase" };

  const itemCardCost = positive(input.itemCardCost);
  if (itemCardCost > 0) return { unitCost: itemCardCost, source: "item_card" };

  return { unitCost: 0, source: "missing" };
}

export function returnCostAdjustmentPerUnit(
  totalAdjustment: number,
  soldQuantity: number,
): number {
  return soldQuantity > 0 ? totalAdjustment / soldQuantity : 0;
}

export function untrackedNegativeStockEstimate(
  negativeBalanceQuantity: number,
  trackedPendingQuantity: number,
  averageCost: number,
): { negativeQuantity: number; untrackedQuantity: number; estimatedValue: number } {
  const negativeQuantity = Math.max(0, Math.abs(negativeBalanceQuantity));
  const untrackedQuantity = Math.max(
    0,
    negativeQuantity - Math.max(0, trackedPendingQuantity),
  );
  return {
    negativeQuantity,
    untrackedQuantity,
    estimatedValue: untrackedQuantity * Math.max(0, averageCost),
  };
}
