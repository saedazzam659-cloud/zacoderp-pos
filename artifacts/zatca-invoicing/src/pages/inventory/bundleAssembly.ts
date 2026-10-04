export type BundleAssemblyLine = {
  itemId: number;
  qty: string | number;
};

export type BundleAssemblyBalance = {
  itemId: number;
  qty: string | number;
  avgCost: string | number;
};

export function summarizeBundleAssembly(
  lines: BundleAssemblyLine[],
  balances: BundleAssemblyBalance[],
  finishedQty: string | number,
) {
  const balanceByItem = new Map(
    balances.map(balance => [Number(balance.itemId), balance]),
  );
  const unitCosts: Record<number, number> = {};
  const requestedByItem = new Map<number, number>();
  const invalidItemIds: number[] = [];
  let materialCost = 0;

  for (const line of lines) {
    const itemId = Number(line.itemId);
    const qty = Number(line.qty);
    if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isFinite(qty) || qty <= 0) {
      invalidItemIds.push(itemId);
      continue;
    }

    const storedQty = Number(qty.toFixed(4));
    const balance = balanceByItem.get(itemId);
    const unitCost = Number(Number(balance?.avgCost ?? 0).toFixed(4));
    unitCosts[itemId] = unitCost;
    requestedByItem.set(itemId, (requestedByItem.get(itemId) ?? 0) + storedQty);
    materialCost += storedQty * unitCost;
  }

  const shortages = Array.from(requestedByItem.entries()).flatMap(([itemId, requested]) => {
    const available = Math.max(0, Number(balanceByItem.get(itemId)?.qty ?? 0));
    return requested > available
      ? [{ itemId, requested, available, shortfall: Number((requested - available).toFixed(4)) }]
      : [];
  });
  const goodQty = Number(finishedQty);
  const validFinishedQty = Number.isFinite(goodQty) && goodQty > 0;

  return {
    materialCost: Number(materialCost.toFixed(4)),
    unitCost: validFinishedQty ? Number((materialCost / goodQty).toFixed(4)) : 0,
    unitCosts,
    shortages,
    invalidItemIds,
    validFinishedQty,
  };
}