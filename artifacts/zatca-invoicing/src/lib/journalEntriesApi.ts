const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

/**
 * Custom error thrown by every JE API helper. Carries the HTTP status so the
 * UI can branch on well-known codes (423 = period locked, 409 = conflict, …)
 * and always surfaces a clean Arabic `message` extracted from the server's
 * JSON `{ error }` body — never the raw JSON envelope.
 */
export class JournalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "JournalApiError";
  }
}

async function readError(r: Response): Promise<JournalApiError> {
  let serverMsg = "";
  try {
    const txt = await r.text();
    if (txt) {
      try {
        const parsed = JSON.parse(txt);
        serverMsg = (parsed && (parsed.error || parsed.message)) || txt;
      } catch { serverMsg = txt; }
    }
  } catch { /* ignore body read errors */ }

  // 423 Locked — fiscal period is closed. We always surface a clear, friendly
  // Arabic message so the user immediately knows WHY the post was blocked and
  // WHAT to do next, instead of seeing the raw server text.
  if (r.status === 423) {
    const friendly = serverMsg
      ? `لا يمكن الترحيل في فترة مقفلة: ${serverMsg}`
      : "لا يمكن الترحيل في فترة مقفلة. أعد فتح الفترة المالية أولاً ثم حاول مرة أخرى.";
    return new JournalApiError(423, friendly);
  }
  return new JournalApiError(r.status, serverMsg || `HTTP ${r.status}`);
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { headers: authHeaders() });
  if (!r.ok) throw await readError(r);
  return r.json();
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw await readError(r);
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw await readError(r);
  return r.json();
}
async function del(path: string): Promise<void> {
  const r = await fetch(`${API}/api${path}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw await readError(r);
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

export interface VatAccountSuggestion {
  accountId: number | null;
  accountLabel: string;
  reasoning: string;
  source: "ai" | "rules";
}

export const journalEntriesApi = {
  list:   (cid?: number) => get<any[]>(`/journal-entries${cid ? `?companyId=${cid}` : ""}`),
  get:    (id: number, cid?: number) => get<any>(`/journal-entries/${id}${cid ? `?companyId=${cid}` : ""}`),
  create: (data: any) => post<any>("/journal-entries", data),
  update: (id: number, data: any) => put<any>(`/journal-entries/${id}`, data),
  remove: (id: number) => del(`/journal-entries/${id}`),
  // Reserve a docNumber + id atomically for a new entry. Returns the
  // locked number that the user can rely on (display, print, share)
  // before the entry is actually saved. Cancelling leaves a numbering
  // gap, which is acceptable for internal journal entries.
  reserve: (data?: { entryDate?: string; branchId?: number | null; currency?: string; exchangeRate?: string; entryType?: string }) =>
    post<{ id: number; docNumber: string; reserved: true }>("/journal-entries/reserve", data ?? {}),
  // Manual post: flips a draft entry to "posted". Server enforces balance,
  // auto-lock and period guards — a non-2xx surfaces a friendly Arabic error.
  post:   (id: number) => post<{ ok: true; alreadyPosted?: boolean }>(`/journal-entries/${id}/post`, {}),
  unpost: (id: number) => post<{ ok: true; alreadyUnposted?: boolean }>(`/journal-entries/${id}/unpost`, {}),
  aiValidate: (data: { entry: any; lines: any[] }) =>
    post<JournalValidationResult>("/ai/validate-journal-entry", data),
  suggestVatAccount: (data: { direction: "input" | "output"; companyId?: number }) =>
    post<VatAccountSuggestion>("/ai/suggest-vat-account", data),
};
