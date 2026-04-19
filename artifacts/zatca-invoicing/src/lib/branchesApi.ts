const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/org${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api/org${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api/org${path}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function del(path: string): Promise<void> {
  const r = await fetch(`${API}/api/org${path}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
}

export const branchesApi = {
  // Regions
  getRegions:   (cid?: number) => get<any[]>(`/regions${cid ? `?companyId=${cid}` : ""}`),
  createRegion: (data: any)    => post<any>("/regions", data),
  updateRegion: (id: number, data: any) => put<any>(`/regions/${id}`, data),
  deleteRegion: (id: number)   => del(`/regions/${id}`),

  // Branches
  getBranches:   (cid?: number, regionId?: number) =>
    get<any[]>(`/branches${cid ? `?companyId=${cid}${regionId ? `&regionId=${regionId}` : ""}` : ""}`),
  createBranch:  (data: any) => post<any>("/branches", data),
  updateBranch:  (id: number, data: any) => put<any>(`/branches/${id}`, data),
  deleteBranch:  (id: number) => del(`/branches/${id}`),
};
