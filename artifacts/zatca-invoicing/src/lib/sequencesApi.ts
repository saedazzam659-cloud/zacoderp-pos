// API client for the centralized Sequence Management System.
// Mirrors the simple fetch pattern used by other api files (currenciesApi etc).

const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, {
    method,
    headers: authHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  // DELETE may return empty body
  const text = await r.text();
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

export type SequenceRow = {
  id: number;
  companyId: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  prefix: string;
  startNumber: number;
  endNumber: number;
  currentNumber: number;
  padLength: number;
  isActive: boolean;
  transactionTypes: string[];
  createdAt: string;
  updatedAt: string;
  // Computed by backend:
  usedCount?: number;
  capacity?: number;
  usedPct?: number;
};

export type SequenceLogRow = {
  id: number;
  sequenceId: number;
  companyId: number;
  transactionType: string;
  generatedNumber: string;
  userId: number | null;
  refTable: string | null;
  refId: string | null;
  createdAt: string;
};

export const sequencesApi = {
  list:             (cid?: number) => request<SequenceRow[]>("GET", `/sequences${cid ? `?companyId=${cid}` : ""}`),
  get:              (id: number)   => request<SequenceRow>("GET", `/sequences/${id}`),
  create:           (data: Partial<SequenceRow>) => request<SequenceRow>("POST", "/sequences", data),
  update:           (id: number, data: Partial<SequenceRow>) => request<SequenceRow>("PATCH", `/sequences/${id}`, data),
  remove:           (id: number)   => request<{ ok: true }>("DELETE", `/sequences/${id}`),
  reset:            (id: number, opts: { acknowledgeReuse?: boolean } = {}) =>
                      request<SequenceRow>("POST", `/sequences/${id}/reset`, opts),
  logs:             (id: number, limit = 50) => request<SequenceLogRow[]>("GET", `/sequences/${id}/logs?limit=${limit}`),
  transactionTypes: () => request<string[]>("GET", "/sequences/transaction-types"),
};
