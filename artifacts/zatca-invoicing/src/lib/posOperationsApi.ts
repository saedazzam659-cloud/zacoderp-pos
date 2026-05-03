// Thin client for POS Operations admin screen.
const API = (import.meta.env.VITE_API_URL ?? "") as string;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(`${API}${url}`, { headers: authHeaders() });
  if (!r.ok) throw new Error((await r.text()) || "حدث خطأ");
  return r.json() as Promise<T>;
}
async function patch<T>(url: string): Promise<T> {
  const r = await fetch(`${API}${url}`, { method: "PATCH", headers: authHeaders() });
  if (!r.ok) {
    let msg = "حدث خطأ";
    try { const j = await r.json(); msg = j?.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export type Cashier = { id: number; username: string; nameAr?: string | null; nameEn?: string | null } | null;
export type Branch  = { id: number; nameAr: string | null; nameEn?: string | null } | null;

export type PosInvoiceRow = {
  id: number;
  docNumber: string | null;
  invoiceDate: string;
  status: "draft" | "posted" | string;
  totalAmount: string;
  vatAmount: string;
  discountAmount: string;
  paymentType: string | null;
  customerId: number | null;
  branchId: number | null;
  posSessionId: number | null;
  zatcaStatus: string | null;
  createdAt: string;
  cashier: Cashier;
  branch: Branch;
  session: { id: number; openedAt: string; closedAt: string | null } | null;
};

export type PosReturnRow = {
  id: number;
  docNumber: string | null;
  returnDate: string;
  status: "draft" | "posted" | string;
  totalAmount: string;
  vatAmount: string;
  paymentType: string | null;
  invoiceId: number | null;
  invoiceDocNumber: string | null;
  branchId: number | null;
  cashier: Cashier;
  branch: Branch;
};

export type PosOpsSummary = {
  from: string; to: string;
  invoices: { total: number; drafts: number; posted: number; posted_total: number; drafts_total: number };
  returns:  { total: number; drafts: number; posted: number; posted_total: number };
};

export type PosOpsInsights = {
  trend: Array<{ day: string; invoices: number; revenue: number; drafts: number }>;
  topCashiers: Array<{ id: number; username: string; nameAr: string | null; nameEn: string | null; invoices: number; revenue: number }>;
  bigTickets: Array<{ id: number; docNumber: string | null; invoiceDate: string; amount: number; status: string; cashier: string | null }>;
  returnRatio: Array<{ username: string; nameAr: string | null; invoices: number; sales: number; returns: number; refunded: number; returnRatePct: number }>;
  staleDrafts: number;
  insights: string[];
  anomalies: Array<{ severity: "high" | "medium" | "low"; title: string; description: string }>;
  source: "ai" | "rule";
};

type ListFilters = {
  status?: string; branchId?: number | null; cashierId?: number | null;
  fromDate?: string; toDate?: string;
};
function qs(f: ListFilters): string {
  const p = new URLSearchParams();
  if (f.status)    p.set("status", f.status);
  if (f.branchId)  p.set("branchId", String(f.branchId));
  if (f.cashierId) p.set("cashierId", String(f.cashierId));
  if (f.fromDate)  p.set("fromDate", f.fromDate);
  if (f.toDate)    p.set("toDate", f.toDate);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const posOperationsApi = {
  invoices:  (f: ListFilters = {}) => get<PosInvoiceRow[]>(`/api/pos-operations/invoices${qs(f)}`),
  returns:   (f: ListFilters = {}) => get<PosReturnRow[]>(`/api/pos-operations/returns${qs(f)}`),
  summary:   (f: ListFilters = {}) => get<PosOpsSummary>(`/api/pos-operations/summary${qs(f)}`),
  insights:  ()                    => get<PosOpsInsights>(`/api/pos-operations-ai/insights`),

  postInvoice:   (id: number) => patch<{ id: number; status: string }>(`/api/sales-invoices/${id}/post`),
  unpostInvoice: (id: number) => patch<{ id: number; status: string }>(`/api/sales-invoices/${id}/unpost`),
  postReturn:    (id: number) => patch<{ id: number; status: string }>(`/api/sales-returns/${id}/post`),
};
