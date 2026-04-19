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
  // Dashboard
  getDashboard: (cid?: number) => get<any>(`/dashboard${cid ? `?companyId=${cid}` : ""}`),
};
