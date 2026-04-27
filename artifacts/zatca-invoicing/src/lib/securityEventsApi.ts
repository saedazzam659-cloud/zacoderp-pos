const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/security-events${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api/security-events${path}`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}/api/security-events${path}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function del<T>(path: string): Promise<T> {
  const r = await fetch(`${API}/api/security-events${path}`, {
    method: "DELETE", headers: authHeaders(),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface SecurityEvent {
  id: number;
  companyId: number;
  branchId: number | null;
  cameraLabel: string | null;
  eventType: string;
  severity: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  videoClipUrl: string | null;
  confidence: string | null;
  eventDateTime: string;
  status: string;
  assignedToUserId: number | null;
  createdByUserId: number | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  assignedToUsername?: string | null;
  createdByUsername?: string | null;
  branchName?: string | null;
}

export interface SecurityEventInput {
  eventType: string;
  severity?: string;
  status?: string;
  title: string;
  description?: string | null;
  cameraLabel?: string | null;
  branchId?: number | null;
  assignedToUserId?: number | null;
  imageUrl?: string | null;
  videoClipUrl?: string | null;
  confidence?: number | null;
  eventDateTime?: string;
  resolutionNote?: string | null;
}

export interface SecurityEventsFilter {
  status?: string;
  type?: string;
  severity?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SecuritySummary {
  totals: { open: number; investigating: number; closed: number; falsePositive: number; total: number };
  byType: Array<{ type: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  last7Days: Array<{ date: string; count: number }>;
}

function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const securityEventsApi = {
  list: (f: SecurityEventsFilter = {}) =>
    get<SecurityEvent[]>(`${qs(f as any)}`),
  summary: (from?: string, to?: string) =>
    get<SecuritySummary>(`/summary${qs({ from, to })}`),
  get: (id: number) =>
    get<SecurityEvent>(`/${id}`),
  create: (input: SecurityEventInput) =>
    post<SecurityEvent>(``, input),
  update: (id: number, input: Partial<SecurityEventInput>) =>
    put<SecurityEvent>(`/${id}`, input),
  remove: (id: number) =>
    del<{ ok: true }>(`/${id}`),
};

export async function aiClassifyEvent(description: string, cameraLabel?: string) {
  const r = await fetch(`${API}/api/ai/security/classify-event`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ description, cameraLabel }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ eventType: string; severity: string; suggestedTitle: string; reasoning: string }>;
}
