// Tiny client for the /api/offers endpoints.
// Mirrors the pattern of inventoryApi.ts so the offers screens stay consistent
// with the rest of the inventory family — Bearer token from localStorage,
// JSON body, throws on non-2xx with the server's text payload.

const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/offers${path}`, {
    method,
    headers: authHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = await r.text();
    try { msg = JSON.parse(msg).error ?? msg; } catch {}
    throw new Error(msg || `HTTP ${r.status}`);
  }
  // 204 / empty body — return undefined cast.
  const ct = r.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? r.json() : (undefined as any);
}

export interface OfferRow {
  id: number;
  offerNumber: string;
  nameAr: string | null;
  description: string | null;
  customerScope: "all" | "specific";
  itemsScope: "all" | "specific";
  salesRepScope: "all" | "specific";
  status: "draft" | "active" | "expired";
  priority: number;
  expiryDate: string | null;
  createdAt: string;
}

export interface OfferDetail extends OfferRow {
  customers: { id: number; offerId: number; customerId: number }[];
  items: { id: number; offerId: number; itemId: number; price: string | null; discount: string | null; qty: string | null }[];
  salesReps: { id: number; offerId: number; salesRepId: number }[];
}

export interface OfferPayload {
  companyId?: number;
  offerNumber?: string;
  nameAr?: string | null;
  description?: string | null;
  customerScope: "all" | "specific";
  itemsScope: "all" | "specific";
  salesRepScope: "all" | "specific";
  status: "draft" | "active";
  priority: number;
  expiryDate?: string | null;
  customers?: number[];
  items?: { itemId: number; price?: string | number | null; discount?: string | number | null; qty?: string | number | null }[];
  salesReps?: number[];
}

export const offersApi = {
  list:     (cid?: number, status?: string) => req<OfferRow[]>("GET", `?${cid ? `companyId=${cid}` : ""}${status ? `&status=${status}` : ""}`),
  getActive:(cid?: number) => req<OfferRow[]>("GET", `/active${cid ? `?companyId=${cid}` : ""}`),
  get:      (id: number, cid?: number) => req<OfferDetail>("GET", `/${id}${cid ? `?companyId=${cid}` : ""}`),
  create:   (payload: OfferPayload) => req<OfferRow>("POST", "", payload),
  update:   (id: number, payload: OfferPayload) => req<{ ok: true }>("PUT", `/${id}`, payload),
  activate: (id: number, cid?: number) => req<{ ok: true }>("POST", `/${id}/activate${cid ? `?companyId=${cid}` : ""}`),
  expire:   (id: number, cid?: number) => req<{ ok: true }>("POST", `/${id}/expire${cid ? `?companyId=${cid}` : ""}`),
  remove:   (id: number, cid?: number) => req<{ ok: true }>("DELETE", `/${id}${cid ? `?companyId=${cid}` : ""}`),
  match:    (payload: { customerId: number; salesRepId?: number; items: { itemId: number }[]; companyId?: number }) =>
    req<{ matches: Record<string, { offerId: number; offerNumber: string; priority: number; nameAr: string | null; price: string | null; discount: string | null; qty: string | null }> }>(
      "POST", "/match", payload),
};
