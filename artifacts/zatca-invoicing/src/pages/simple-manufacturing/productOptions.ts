import type { Catalog } from "./types";

/** A configured manufacturing output remains selectable regardless of its
 * inventory classification. Never invent options outside the tenant catalog. */
export function manufacturingProducts(catalog: Catalog, selectedId = "") {
  const configured = new Set<string>([
    selectedId,
    ...(catalog.bomTemplates ?? []).map(row => String(row.productItemId)),
    ...catalog.routings.map(row => String(row.productItemId)),
    ...catalog.templates.map(row => String(row.configuration?.productItemId)),
  ]);
  return catalog.items.filter(item =>
    !item.itemNature || item.itemNature === "finished" || item.itemNature === "semi"
    || configured.has(String(item.id)),
  );
}