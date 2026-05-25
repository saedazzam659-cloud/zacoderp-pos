// Tiny REST client for the standalone Credit/Debit Notes API.
// Mirrors the lightweight `sisterCompaniesApi` style — plain fetch + Bearer
// auth so we don't need the OpenAPI generator for this isolated module.
const API = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (t) h["Authorization"] = `Bearer ${t}`;
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}

async function jsonOrThrow(r: Response) {
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let msg = text;
    try { msg = JSON.parse(text)?.error ?? text; } catch { /* keep text */ }
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return r.json();
}

export type AccountNotePartyType = "customer" | "supplier";
export type AccountNoteType      = "credit" | "debit";
export type AccountNoteStatus    = "draft" | "posted" | "cancelled";

export interface AccountNote {
  id: number;
  companyId: number;
  branchId: number | null;
  noteNumber: string;
  noteDate: string;
  partyType: AccountNotePartyType;
  noteType: AccountNoteType;
  partyId: number;
  partyAccountId: number;
  contraAccountId: number;
  amount: string;
  vatEnabled: boolean;
  vatRate: string;
  vatAccountId: number | null;
  vatAmount: string;
  totalAmount: string;
  description: string | null;
  notes: string | null;
  status: AccountNoteStatus;
  journalEntryId: number | null;
}

export const accountNotesApi = {
  list(filter: { partyType?: AccountNotePartyType; noteType?: AccountNoteType; status?: AccountNoteStatus } = {}): Promise<AccountNote[]> {
    const qs = new URLSearchParams();
    if (filter.partyType) qs.set("partyType", filter.partyType);
    if (filter.noteType)  qs.set("noteType",  filter.noteType);
    if (filter.status)    qs.set("status",    filter.status);
    return fetch(`${API}/api/account-notes?${qs.toString()}`, { headers: authHeaders() }).then(jsonOrThrow);
  },
  get(id: number): Promise<AccountNote> {
    return fetch(`${API}/api/account-notes/${id}`, { headers: authHeaders() }).then(jsonOrThrow);
  },
  create(body: Partial<AccountNote>): Promise<AccountNote> {
    return fetch(`${API}/api/account-notes`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) }).then(jsonOrThrow);
  },
  update(id: number, body: Partial<AccountNote>): Promise<{ ok: boolean }> {
    return fetch(`${API}/api/account-notes/${id}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) }).then(jsonOrThrow);
  },
  post(id: number): Promise<{ ok: boolean; journalEntryId: number; journalEntryStatus: "posted" | "draft" }> {
    return fetch(`${API}/api/account-notes/${id}/post`, { method: "POST", headers: authHeaders() }).then(jsonOrThrow);
  },
  unpost(id: number): Promise<{ ok: boolean }> {
    return fetch(`${API}/api/account-notes/${id}/unpost`, { method: "POST", headers: authHeaders() }).then(jsonOrThrow);
  },
  delete(id: number): Promise<{ ok: boolean }> {
    return fetch(`${API}/api/account-notes/${id}`, { method: "DELETE", headers: authHeaders() }).then(jsonOrThrow);
  },
};
