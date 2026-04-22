const API = (import.meta.env.VITE_API_URL ?? "") as string;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/pos-sessions${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error((await r.text()) || "حدث خطأ");
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/pos-sessions${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.text()) || "حدث خطأ");
  return r.json() as Promise<T>;
}

export type PosSessionRow = {
  id: number;
  companyId: number;
  userId: number;
  branchId: number | null;
  cashBoxId: number | null;
  openingCash: string;
  closingCash: string | null;
  expectedCash: string | null;
  difference: string | null;
  openedAt: string;
  closedAt: string | null;
  status: "open" | "closed" | "force_closed";
  device: string | null;
  notes: string | null;
  closedNotes: string | null;
  user: { id: number; username: string; nameAr?: string | null; nameEn?: string | null } | null;
  branch: { id: number; nameAr: string } | null;
  cashBox: { id: number; nameAr: string } | null;
  invoiceCount: number;
  totalSales: number;
};

export type PosSessionDetail = PosSessionRow & {
  invoices: Array<{
    id: number;
    docNumber: string | null;
    invoiceDate: string;
    totalAmount: string;
    vatAmount: string;
    status: string;
    paymentType: string | null;
    createdAt: string;
  }>;
};

export type PosTodaySummary = {
  openSessions: number;
  closedToday: number;
  invoiceCount: number;
  totalSales: number;
};

export type PosListFilters = {
  companyId?: number | null;
  status?: "open" | "closed" | "force_closed" | "";
  branchId?: number | null;
  userId?: number | null;
  from?: string;
  to?: string;
};

function qs(o: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const posMonitoringApi = {
  list: (f: PosListFilters = {}) => get<PosSessionRow[]>(`${qs(f)}`),
  get: (id: number) => get<PosSessionDetail>(`/${id}`),
  summaryToday: (companyId?: number | null) =>
    get<PosTodaySummary>(`/summary/today${qs({ companyId })}`),
  forceClose: (id: number, notes?: string) =>
    post<PosSessionRow>(`/${id}/close`, { notes }),
};
