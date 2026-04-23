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

export interface JournalValidationResult {
  isBalanced: boolean;
  totalDebit: number;
  totalCredit: number;
  diff: number;
  suggestion: string;
  issues: string[];
  summary: string;
  source: "ai" | "fallback";
}

export const journalEntriesApi = {
  list:   (cid?: number) => get<any[]>(`/journal-entries${cid ? `?companyId=${cid}` : ""}`),
  get:    (id: number, cid?: number) => get<any>(`/journal-entries/${id}${cid ? `?companyId=${cid}` : ""}`),
  create: (data: any) => post<any>("/journal-entries", data),
  update: (id: number, data: any) => put<any>(`/journal-entries/${id}`, data),
  remove: (id: number) => del(`/journal-entries/${id}`),
  aiValidate: (data: { entry: any; lines: any[] }) =>
    post<JournalValidationResult>("/ai/validate-journal-entry", data),
};
