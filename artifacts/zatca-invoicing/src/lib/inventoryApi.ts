const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/inventory${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api/inventory${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api/inventory${path}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function del(path: string): Promise<void> {
  const r = await fetch(`${API}/api/inventory${path}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
}

// ─── PRO Extension #17 — Item Suppliers ─────────────────────────────────────
// Per-link metadata between an item and one of the company's suppliers.
// `supplierName`/`supplierCode` come from the LEFT JOIN on the GET endpoint.
export interface ItemSupplier {
  id: number;
  companyId: number;
  itemId: number;
  supplierId: number;
  supplierItemCode: string | null;
  lastPurchasePrice: string | null;
  lastPurchaseDate: string | null;
  leadTimeDays: number | null;
  preferredSupplier: boolean;
  notes: string | null;
  createdAt: string;
  // Joined from suppliers table (read-only):
  supplierName?: string | null;
  supplierNameEn?: string | null;
  supplierCode?: string | null;
}

// ─── PRO Extension #20 — Item Variants ──────────────────────────────────────
// A variant is a full-fledged item whose `parentItemId` points to another
// item in the same tenant (e.g. "T-Shirt – Red – L" under "T-Shirt"). The
// `variantAttributes` JSON is a free-form `{ key: value }` blob so different
// industries can model whatever attribute set fits (color/size/flavor/...).
export interface ItemVariant {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  barcode: string | null;
  costPrice: string;
  salePrice: string;
  vatRate: string;
  parentItemId: number;
  variantAttributes: Record<string, string | number | boolean | null> | null;
  status: "active" | "inactive";
  createdAt: string;
}
export interface VariantsResponse {
  parent: { id: number; code: string; nameAr: string; isVariant: boolean; isBundle: boolean };
  variants: ItemVariant[];
}

// ─── PRO Extension #2 — Bundle Components ───────────────────────────────────
export interface BundleComponent {
  id: number;
  parentItemId: number;
  childItemId: number;
  qty: string;
  notes: string | null;
  createdAt: string;
  // Joined from items table (read-only):
  childCode?: string | null;
  childNameAr?: string | null;
  childNameEn?: string | null;
  childSalePrice?: string | null;
  childCostPrice?: string | null;
  childIsBundle?: boolean | null;
}
export interface BundleResponse {
  isBundle: boolean;
  components: BundleComponent[];
}

export const inventoryApi = {
  // Warehouse Groups
  getWarehouseGroups:   (cid?: number) => get<any[]>(`/warehouse-groups${cid ? `?companyId=${cid}` : ""}`),
  createWarehouseGroup: (data: any)    => post<any>("/warehouse-groups", data),
  updateWarehouseGroup: (id: number, data: any) => put<any>(`/warehouse-groups/${id}`, data),
  deleteWarehouseGroup: (id: number)   => del(`/warehouse-groups/${id}`),
  // Warehouses
  getWarehouses:   (cid?: number) => get<any[]>(`/warehouses${cid ? `?companyId=${cid}` : ""}`),
  createWarehouse: (data: any)    => post<any>("/warehouses", data),
  updateWarehouse: (id: number, data: any) => put<any>(`/warehouses/${id}`, data),
  deleteWarehouse: (id: number)   => del(`/warehouses/${id}`),
  // PRO Extension #17 — Item Suppliers
  getItemSuppliers:    (itemId: number)             => get<ItemSupplier[]>(`/items/${itemId}/suppliers`),
  addItemSupplier:     (itemId: number, data: any)  => post<ItemSupplier>(`/items/${itemId}/suppliers`, data),
  updateItemSupplier:  (itemId: number, linkId: number, data: any) => put<ItemSupplier>(`/items/${itemId}/suppliers/${linkId}`, data),
  deleteItemSupplier:  (itemId: number, linkId: number) => del(`/items/${itemId}/suppliers/${linkId}`),
  // PRO Extension #2 — Bundle Components
  getBundleComponents:    (itemId: number)             => get<BundleResponse>(`/items/${itemId}/bundle/components`),
  addBundleComponent:     (itemId: number, data: any)  => post<BundleComponent>(`/items/${itemId}/bundle/components`, data),
  updateBundleComponent:  (itemId: number, linkId: number, data: any) => put<BundleComponent>(`/items/${itemId}/bundle/components/${linkId}`, data),
  deleteBundleComponent:  (itemId: number, linkId: number) => del(`/items/${itemId}/bundle/components/${linkId}`),
  // PRO Extension #20 — Item Variants
  getItemVariants:    (itemId: number)            => get<VariantsResponse>(`/items/${itemId}/variants`),
  addItemVariant:     (itemId: number, data: any) => post<ItemVariant>(`/items/${itemId}/variants`, data),
  // Updating a variant goes through the general updateItem (variants ARE items),
  // and deleting goes through deleteItem. We expose addItemVariant/getItemVariants
  // as sugar so the UI doesn't have to construct the parent_item_id payload.
  // Item Groups
  getItemGroups:   (cid?: number) => get<any[]>(`/item-groups${cid ? `?companyId=${cid}` : ""}`),
  createItemGroup: (data: any)    => post<any>("/item-groups", data),
  updateItemGroup: (id: number, data: any) => put<any>(`/item-groups/${id}`, data),
  deleteItemGroup: (id: number)   => del(`/item-groups/${id}`),
  // Units
  getUnits:   (cid?: number) => get<any[]>(`/units${cid ? `?companyId=${cid}` : ""}`),
  createUnit: (data: any)    => post<any>("/units", data),
  updateUnit: (id: number, data: any) => put<any>(`/units/${id}`, data),
  deleteUnit: (id: number)   => del(`/units/${id}`),
  // Items
  getItems:   (cid?: number) => get<any[]>(`/items${cid ? `?companyId=${cid}` : ""}`),
  getItem:    (id: number)   => get<any>(`/items/${id}`),
  createItem: (data: any)    => post<any>("/items", data),
  updateItem: (id: number, data: any) => put<any>(`/items/${id}`, data),
  deleteItem: (id: number)   => del(`/items/${id}`),
  getItemAudit: (id: number) => get<any[]>(`/items/${id}/audit`),
  // Item Unit Prices
  getItemUnits:    (itemId: number)                  => get<any[]>(`/items/${itemId}/units`),
  getItemUnitPrice: (itemId: number, unitId: number) => get<any>(`/items/${itemId}/units/${unitId}`),
  addItemUnit:     (itemId: number, data: any)       => post<any>(`/items/${itemId}/units`, data),
  updateItemUnit:  (itemId: number, upId: number, data: any) => put<any>(`/items/${itemId}/units/${upId}`, data),
  deleteItemUnit:  (itemId: number, upId: number)    => del(`/items/${itemId}/units/${upId}`),
  // Stock Transfers
  getTransfers:   (cid?: number) => get<any[]>(`/stock-transfers${cid ? `?companyId=${cid}` : ""}`),
  getTransfer:    (id: number)   => get<any>(`/stock-transfers/${id}`),
  createTransfer: (data: any)    => post<any>("/stock-transfers", data),
  updateTransfer: (id: number, data: any) => put<any>(`/stock-transfers/${id}`, data),
  postTransfer:   (id: number)   => post<any>(`/stock-transfers/${id}/post`, {}),
  deleteTransfer: (id: number)   => del(`/stock-transfers/${id}`),
  // Stock Adjustments
  getAdjustments:   (cid?: number) => get<any[]>(`/stock-adjustments${cid ? `?companyId=${cid}` : ""}`),
  getAdjustment:    (id: number)   => get<any>(`/stock-adjustments/${id}`),
  createAdjustment: (data: any)    => post<any>("/stock-adjustments", data),
  updateAdjustment: (id: number, data: any) => put<any>(`/stock-adjustments/${id}`, data),
  postAdjustment:   (id: number)   => post<any>(`/stock-adjustments/${id}/post`, {}),
  deleteAdjustment: (id: number)   => del(`/stock-adjustments/${id}`),
  // Stock Counts
  getCounts:   (cid?: number) => get<any[]>(`/stock-counts${cid ? `?companyId=${cid}` : ""}`),
  getCount:    (id: number)   => get<any>(`/stock-counts/${id}`),
  createCount: (data: any)    => post<any>("/stock-counts", data),
  updateCount: (id: number, data: any) => put<any>(`/stock-counts/${id}`, data),
  postCount:   (id: number)   => post<any>(`/stock-counts/${id}/post`, {}),
  deleteCount: (id: number)   => del(`/stock-counts/${id}`),
  // Ledger & Balance
  getLedger:  (params: Record<string, string>) => get<any[]>(`/stock-ledger?${new URLSearchParams(params)}`),
  getBalance: (params: Record<string, string>) => get<any[]>(`/stock-balance?${new URLSearchParams(params)}`),
  getLastMovements: (cid?: number) => get<{ itemId: number; lastDate: string }[]>(`/last-movements${cid ? `?companyId=${cid}` : ""}`),
  // Dashboard
  getDashboard: (cid?: number) => get<any>(`/dashboard${cid ? `?companyId=${cid}` : ""}`),
  // PRO Extension #5 — per-item analytics (last sold, qty, revenue, avg monthly)
  getItemAnalytics: (id: number) => get<{
    itemId: number;
    lastSoldDate: string | null;
    totalSalesQty: number;
    totalRevenue: number;
    averageMonthlySales: number;
    invoiceCount: number;
  }>(`/items/${id}/analytics`),
  // PRO Extension #6 — unified inventory smart alerts (low-stock + idle items)
  getInventoryAlerts: (idleDays?: number) => get<{
    idleDays: number;
    lowStock: { itemId: number | null; code: string; nameAr: string; nameEn: string | null; totalQty: number; reorderLevel: number }[];
    idle:     { itemId: number; code: string; nameAr: string; nameEn: string | null; lastSoldDate: string; daysIdle: number }[];
  }>(`/alerts${idleDays ? `?idleDays=${idleDays}` : ""}`),
  // PRO Extension #10 — item documents (warranty / certificates / manuals)
  getItemDocuments: (itemId: number) =>
    get<ItemDocument[]>(`/items/${itemId}/documents`),
  addItemDocument: (itemId: number, data: {
    fileUrl: string; fileName: string; fileType?: string; fileSize?: number; category?: string; notes?: string;
  }) => post<ItemDocument>(`/items/${itemId}/documents`, data),
  deleteItemDocument: (itemId: number, docId: number) =>
    del(`/items/${itemId}/documents/${docId}`),

  // PRO Extension #8 — multi-currency override prices per item
  getItemCurrencyPrices: (itemId: number) =>
    get<ItemCurrencyPrice[]>(`/items/${itemId}/currency-prices`),
  addItemCurrencyPrice: (itemId: number, data: {
    currencyCode: string; costPrice: number | string; salePrice: number | string; notes?: string;
  }) => post<ItemCurrencyPrice>(`/items/${itemId}/currency-prices`, data),
  updateItemCurrencyPrice: (itemId: number, rowId: number, data: Partial<{
    costPrice: number | string; salePrice: number | string; notes: string;
  }>) => put<ItemCurrencyPrice>(`/items/${itemId}/currency-prices/${rowId}`, data),
  deleteItemCurrencyPrice: (itemId: number, rowId: number) =>
    del(`/items/${itemId}/currency-prices/${rowId}`),

  // PRO Extension #9 — per-branch stock & reorder thresholds
  getItemBranchStock: (itemId: number) =>
    get<ItemBranchStockRow[]>(`/items/${itemId}/branch-stock`),
  upsertItemBranchStock: (itemId: number, branchId: number, data: {
    qty: number | string; reorderLevel?: number | string | null; maxLevel?: number | string | null; notes?: string;
  }) => put<any>(`/items/${itemId}/branch-stock/${branchId}`, data),
  deleteItemBranchStock: (itemId: number, rowId: number) =>
    del(`/items/${itemId}/branch-stock/${rowId}`),

  // PRO Extension #16 — smart reorder suggestion
  getReorderSuggestion: (itemId: number) =>
    get<ReorderSuggestion>(`/items/${itemId}/reorder-suggestion`),

  // PRO Extension #18 — manufacturing BOM steps
  getItemBomSteps: (itemId: number) =>
    get<BomStepsResponse>(`/items/${itemId}/bom-steps`),
  addItemBomStep: (itemId: number, data: {
    sequence?: number; nameAr: string; nameEn?: string;
    durationMinutes?: number; laborCost?: number | string; overheadCost?: number | string; notes?: string;
  }) => post<BomStep>(`/items/${itemId}/bom-steps`, data),
  updateItemBomStep: (itemId: number, stepId: number, data: Partial<{
    sequence: number; nameAr: string; nameEn: string;
    durationMinutes: number; laborCost: number | string; overheadCost: number | string; notes: string;
  }>) => put<BomStep>(`/items/${itemId}/bom-steps/${stepId}`, data),
  deleteItemBomStep: (itemId: number, stepId: number) =>
    del(`/items/${itemId}/bom-steps/${stepId}`),

  // PRO Extension #15 — scan tenant for low-stock items and create
  // broadcast notifications (idempotent per item per day via sourceKey).
  notifyLowStock: () =>
    post<{ scanned: number; created: number; skippedAlreadyNotified: number; skippedAboveThreshold: number }>(
      `/alerts/notify`, {}),
};

export interface ItemCurrencyPrice {
  id: number; companyId: number; itemId: number;
  currencyCode: string;
  costPrice: string; salePrice: string;
  notes: string | null;
  createdAt: string; updatedAt: string;
}

export interface ItemBranchStockRow {
  branchId: number; branchCode: string; branchNameAr: string; branchNameEn: string | null; isMain: boolean;
  rowId: number | null;
  qty: string;
  reorderLevel: string | null;
  maxLevel: string | null;
  notes: string | null;
}

export interface ReorderSuggestion {
  itemId: number; code: string; nameAr: string; nameEn: string | null;
  inputs: {
    currentStock: number;
    avgMonthlySales: number;
    dailyVelocity: number;
    leadTimeDays: number;
    reorderLevel: number;
    maxLevel: number | null;
    safetyFactor: number;
  };
  computed: {
    leadTimeConsumption: number;
    targetStock: number;
    suggestedOrderQty: number;
    needsReorder: boolean;
  };
}

export interface BomStep {
  id: number; companyId: number; itemId: number;
  sequence: number;
  nameAr: string; nameEn: string | null;
  durationMinutes: number | null;
  laborCost: string; overheadCost: string;
  notes: string | null;
  createdAt: string; updatedAt: string;
}

export interface BomStepsResponse {
  steps: BomStep[];
  totals: {
    stepCount: number;
    totalDurationMin: number;
    totalLaborCost: number;
    totalOverheadCost: number;
    componentCost: number;
    manufacturedCost: number;
  };
}

export interface ItemDocument {
  id: number;
  companyId: number;
  itemId: number;
  fileUrl: string;
  fileName: string;
  fileType: string | null;
  fileSize: number | null;
  category: string;
  notes: string | null;
  uploadedByUserId: number | null;
  createdAt: string;
}
