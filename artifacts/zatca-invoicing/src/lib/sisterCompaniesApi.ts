// Sister Companies API helper — mirrors inventoryApi.ts pattern (fetch + bearer token).
// All endpoints live under /api/sister-companies/* and are gated server-side by
// `requireModulePermission("sister_companies")`. If the module is OFF for the
// tenant, every call returns 403.
const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/sister-companies${path}`, {
    method,
    headers: authHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return undefined as any;
  return r.json();
}

export interface SisterCompany {
  id: number;
  companyId: number;
  branchId: number | null;
  nameAr: string;
  nameEn: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  accountId: number | null;
  defaultCogsAccountId: number | null;
  defaultRevenueAccountId: number | null;
  defaultInventoryAccountId: number | null;
  notes: string | null;
  isActive: boolean;
}

export interface SisterTransfer {
  id: number;
  branchId: number | null;
  transferNumber: string;
  transferDate: string;
  sisterCompanyId: number;
  fromWarehouseId: number;
  totalCost: string;
  totalSupply: string;
  status: "draft" | "posted" | "cancelled";
  journalEntryId: number | null;
  notes: string | null;
  items?: any[];
}

export interface SisterReturn {
  id: number;
  branchId: number | null;
  returnNumber: string;
  returnDate: string;
  transferId: number;
  sisterCompanyId: number;
  toWarehouseId: number;
  totalCost: string;
  totalSupply: string;
  status: "draft" | "posted" | "cancelled";
  journalEntryId: number | null;
  notes: string | null;
  items?: any[];
}

export interface SisterSettlement {
  id: number;
  branchId: number | null;
  code: string;
  date: string;
  sisterCompanyId: number;
  direction: "receive" | "pay";
  paymentType: "cash" | "bank";
  cashBoxId: number | null;
  bankAccountId: number | null;
  amount: string;
  description: string | null;
  status: "draft" | "posted" | "cancelled";
  journalEntryId: number | null;
}

export const sisterCompaniesApi = {
  // ── Sisters CRUD
  list:    ()                     => req<SisterCompany[]>("GET", "/"),
  get:     (id: number)           => req<SisterCompany>("GET", `/${id}`),
  create:  (body: Partial<SisterCompany>) => req<SisterCompany>("POST", "/", body),
  update:  (id: number, body: Partial<SisterCompany>) => req<SisterCompany>("PUT", `/${id}`, body),
  remove:  (id: number)           => req<{ ok: true }>("DELETE", `/${id}`),
  balance: (id: number)           => req<{ balance: number }>("GET", `/${id}/balance`),

  // ── Transfers
  listTransfers:   (sisterCompanyId?: number) =>
    req<SisterTransfer[]>("GET", `/transfers${sisterCompanyId ? `?sisterCompanyId=${sisterCompanyId}` : ""}`),
  getTransfer:     (id: number)               => req<SisterTransfer>("GET", `/transfers/${id}`),
  createTransfer:  (body: any)                => req<SisterTransfer>("POST", "/transfers", body),
  updateTransfer:  (id: number, body: any)    => req<{ ok: true }>("PUT", `/transfers/${id}`, body),
  postTransfer:    (id: number)               => req<{ ok: true; journalEntryId: number }>("POST", `/transfers/${id}/post`),
  deleteTransfer:  (id: number)               => req<{ ok: true }>("DELETE", `/transfers/${id}`),

  // ── Returns
  listReturns:   ()             => req<SisterReturn[]>("GET", "/returns"),
  getReturn:     (id: number)   => req<SisterReturn>("GET", `/returns/${id}`),
  createReturn:  (body: any)    => req<SisterReturn>("POST", "/returns", body),
  postReturn:    (id: number)   => req<{ ok: true; journalEntryId: number }>("POST", `/returns/${id}/post`),
  deleteReturn:  (id: number)   => req<{ ok: true }>("DELETE", `/returns/${id}`),

  // ── Settlements
  listSettlements:   ()             => req<SisterSettlement[]>("GET", "/settlements"),
  getSettlement:     (id: number)   => req<SisterSettlement>("GET", `/settlements/${id}`),
  createSettlement:  (body: any)    => req<SisterSettlement>("POST", "/settlements", body),
  postSettlement:    (id: number)   => req<{ ok: true; journalEntryId: number }>("POST", `/settlements/${id}/post`),
  deleteSettlement:  (id: number)   => req<{ ok: true }>("DELETE", `/settlements/${id}`),

  // ── Statement
  statement: (sisterCompanyId: number, from?: string, to?: string, branchId?: number) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to)   qs.set("to", to);
    if (branchId) qs.set("branchId", String(branchId));
    return req<{
      opening: number;
      closing: number;
      rows: Array<{
        id: number;
        kind: "transfer" | "return" | "settlement";
        date: string;
        docNumber: string;
        type: string;
        journalEntryId: number | null;
        journalEntryNumber: string | null;
        debit: number;
        credit: number;
        description: string;
        balance: number;
      }>;
    }>("GET", `/${sisterCompanyId}/statement${qs.toString() ? `?${qs}` : ""}`);
  },
};
