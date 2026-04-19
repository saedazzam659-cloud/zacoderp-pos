const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function del(path: string): Promise<void> {
  const r = await fetch(`${API}/api${path}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
}

export const currenciesApi = {
  list:         (cid?: number) => get<any[]>(`/currencies${cid ? `?companyId=${cid}` : ""}`),
  create:       (data: any)    => post<any>("/currencies", data),
  update:       (id: number, data: any) => put<any>(`/currencies/${id}`, data),
  remove:       (id: number)   => del(`/currencies/${id}`),

  listRates:    (cid?: number) => get<any[]>(`/currencies/rates${cid ? `?companyId=${cid}` : ""}`),
  createRate:   (data: any)    => post<any>("/currencies/rates", data),
  updateRate:   (id: number, data: any) => put<any>(`/currencies/rates/${id}`, data),
  removeRate:   (id: number)   => del(`/currencies/rates/${id}`),
};
