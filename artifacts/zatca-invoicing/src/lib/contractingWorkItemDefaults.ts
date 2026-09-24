export type ContractWorkItemSource = {
  id: number;
  code: string | null;
  nameAr: string;
  unit: string;
  plannedQty: string;
};

/** A proposed new contract row, never an update to a saved agreement. */
export function contractWorkItemDefaults(item: ContractWorkItemSource) {
  return {
    workItemId: String(item.id),
    lineCode: item.code ?? "",
    description: item.nameAr,
    unit: item.unit,
    quantity: String(item.plannedQty ?? "0"),
    // Project WBS carries only estimated unit cost, not a canonical owner
    // sale price. Neither owner nor subcontract rates can come from that cost.
    unitPrice: "0",
    sourceOwnerLineId: "",
    baseLineId: "",
    quantityDelta: "0",
    unitPriceDelta: "0",
    unitPriceOverride: "",
  };
}