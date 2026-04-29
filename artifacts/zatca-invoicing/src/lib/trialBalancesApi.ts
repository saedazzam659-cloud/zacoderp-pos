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
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, {
    method: "POST", headers: authHeaders(), body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function del(path: string): Promise<void> {
  const r = await fetch(`${API}/api${path}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
}

export type TrialBalanceStatus = "draft" | "in_review" | "approved";
export type TrialBalanceType   = "opening" | "before_review" | "after_review" | "closing";

export interface TrialBalance {
  id: number;
  companyId: number;
  fiscalYearId: number | null;
  fiscalYear: string;
  periodStart: string;
  periodEnd: string;
  balanceType: TrialBalanceType;
  status: TrialBalanceStatus;
  notes: string | null;
  totalDebit: string;
  totalCredit: string;
  sourceTrialBalanceId: number | null;
  createdBy: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrialBalanceDetail {
  id: number;
  trialBalanceId: number;
  accountId: number | null;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  originalDebit: string;
  originalCredit: string;
  changeReason: string | null;
  isUnlinked: number;
  sortOrder: number;
}

export interface TrialBalanceAdjustment {
  id: number;
  trialBalanceId: number;
  journalEntryId: number | null;
  description: string;
  category: string;
  amount: string;
  createdBy: number | null;
  createdAt: string;
}

export interface TrialBalanceLog {
  id: number;
  trialBalanceId: number;
  userId: number | null;
  action: string;
  details: any;
  createdAt: string;
}

export interface TrialBalanceFull extends TrialBalance {
  details: TrialBalanceDetail[];
  adjustments: TrialBalanceAdjustment[];
  logs: TrialBalanceLog[];
}

export interface CompareResult {
  base: TrialBalance;
  other: TrialBalance;
  lines: Array<{
    accountCode: string;
    accountName: string;
    baseDebit: string;
    baseCredit: string;
    otherDebit: string;
    otherCredit: string;
    diffDebit: string;
    diffCredit: string;
    changed: boolean;
  }>;
  summary: { changedCount: number; totalCount: number };
}

export interface ImportLine {
  accountCode: string;
  accountName?: string;
  debit?: number | string;
  credit?: number | string;
}

export const trialBalancesApi = {
  list: () => get<TrialBalance[]>("/trial-balances"),
  get: (id: number) => get<TrialBalanceFull>(`/trial-balances/${id}`),
  create: (data: Partial<TrialBalance>) => post<TrialBalance>("/trial-balances", data),
  update: (id: number, data: Partial<TrialBalance>) => put<TrialBalance>(`/trial-balances/${id}`, data),
  remove: (id: number) => del(`/trial-balances/${id}`),

  importLines: (id: number, lines: ImportLine[], replace = true) =>
    post<{ ok: boolean; count: number; details: TrialBalanceDetail[] }>(
      `/trial-balances/${id}/import`, { lines, replace }
    ),

  addLine: (id: number, line: Partial<TrialBalanceDetail>) =>
    post<TrialBalanceDetail>(`/trial-balances/${id}/details`, line),

  editLine: (id: number, lineId: number, patch: Partial<TrialBalanceDetail>) =>
    put<TrialBalanceDetail>(`/trial-balances/${id}/details/${lineId}`, patch),

  deleteLine: (id: number, lineId: number) =>
    del(`/trial-balances/${id}/details/${lineId}`),

  compare: (id: number, otherId: number) =>
    get<CompareResult>(`/trial-balances/${id}/compare/${otherId}`),

  addAdjustment: (id: number, payload: {
    description: string; category?: string; entryDate?: string;
    lines: Array<{ accountId: number; debit?: number | string; credit?: number | string; description?: string }>;
  }) => post<{ adjustment: TrialBalanceAdjustment; journalEntryId: number }>(
    `/trial-balances/${id}/adjustments`, payload
  ),

  approve: (id: number) => post<TrialBalance>(`/trial-balances/${id}/approve`),
  convertToClosing: (id: number) => post<TrialBalance>(`/trial-balances/${id}/convert-to-closing`),

  report: (id: number, type: "detailed" | "summary" | "before-after" | "adjustments") =>
    get<any>(`/trial-balances/${id}/report?type=${type}`),

  aiAnalyze: (payload: {
    totalDebit: number | string; totalCredit: number | string;
    lines: Array<{ accountCode: string; accountName: string; accountType?: string; debit: number | string; credit: number | string }>;
  }) => post<{
    source: "ai" | "fallback";
    balanced: boolean;
    difference: number;
    imbalanceReason: string;
    abnormalAccounts: Array<{ accountCode: string; accountName: string; reason: string; severity: "low" | "medium" | "high" }>;
    suggestions: Array<{ description: string; lines: Array<{ accountCode: string; debit: number; credit: number }> }>;
  }>("/ai/analyze-trial-balance", payload),
};
