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
  // Optional dynamic pattern inserted between prefix and the running number.
  // Tokens: `{MM}` `{M}` `{YY}` `{YYYY}`. NULL/empty = legacy format.
  monthPattern?: string | null;
  startNumber: number;
  endNumber: number;
  currentNumber: number;
  padLength: number;
  isActive: boolean;
  // When true, the running counter restarts at `startNumber` at the beginning
  // of each calendar month. Pair with a `{MM}` monthPattern so each month gets
  // a distinct stream and never collides. Default false = continuous numbering.
  monthlyReset?: boolean;
  transactionTypes: string[];
  // Optional whitelist of branch IDs allowed to use this sequence. An empty
  // array means "all branches" (preserves the original behavior).
  branchIds: number[];
  // Optional whitelist of fiscal-period IDs this sequence applies to. An
  // empty array means "all periods" (universal — the legacy default). When
  // non-empty, this sequence is ONLY used for documents whose effective
  // date falls inside one of the listed periods. Scoped sequences take
  // priority over universal ones during issuance, so a tenant can keep a
  // single all-years sequence and add an override per fiscal year.
  fiscalPeriodIds: number[];
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

// Per-table breakdown of how many EXISTING documents still reference numbers
// issued by a sequence. Drives the reset dialog + the 409 block message.
export type SequenceLinkBreakdown = { refTable: string; count: number };

export type ResetEligibility = {
  eligible: boolean;
  linkedCount: number;
  breakdown: SequenceLinkBreakdown[];
};

// Enriched activity row for the monitoring screen. `live` = does the linked
// document still exist? (null when the row has no resolvable document link.)
export type SequenceActivityRow = SequenceLogRow & {
  sequenceCode: string | null;
  sequenceName: string | null;
  userName: string | null;
  live: boolean | null;
};

export type SequenceActivityParams = {
  txTypes?: string[];
  sequenceId?: number | null;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  limit?: number;
  offset?: number;
  includeReset?: boolean;
};

export const sequencesApi = {
  list:             (cid?: number) => request<SequenceRow[]>("GET", `/sequences${cid ? `?companyId=${cid}` : ""}`),
  get:              (id: number)   => request<SequenceRow>("GET", `/sequences/${id}`),
  create:           (data: Partial<SequenceRow>) => request<SequenceRow>("POST", "/sequences", data),
  update:           (id: number, data: Partial<SequenceRow>) => request<SequenceRow>("PATCH", `/sequences/${id}`, data),
  remove:           (id: number)   => request<{ ok: true }>("DELETE", `/sequences/${id}`),
  reset:            (id: number, opts: { acknowledgeReuse?: boolean } = {}) =>
                      request<SequenceRow>("POST", `/sequences/${id}/reset`, opts),
  resetEligibility: (id: number) => request<ResetEligibility>("GET", `/sequences/${id}/reset-eligibility`),
  logs:             (id: number, limit = 50) => request<SequenceLogRow[]>("GET", `/sequences/${id}/logs?limit=${limit}`),
  activity:         (params: SequenceActivityParams = {}) => {
    const qs = new URLSearchParams();
    if (params.txTypes?.length) qs.set("txTypes", params.txTypes.join(","));
    if (params.sequenceId)      qs.set("sequenceId", String(params.sequenceId));
    if (params.dateFrom)        qs.set("dateFrom", params.dateFrom);
    if (params.dateTo)          qs.set("dateTo", params.dateTo);
    if (params.q)               qs.set("q", params.q);
    if (params.limit != null)   qs.set("limit", String(params.limit));
    if (params.offset != null)  qs.set("offset", String(params.offset));
    if (params.includeReset)    qs.set("includeReset", "true");
    const s = qs.toString();
    return request<{ rows: SequenceActivityRow[]; total: number; limit: number; offset: number }>(
      "GET", `/sequences/logs/all${s ? `?${s}` : ""}`);
  },
  transactionTypes: () => request<string[]>("GET", "/sequences/transaction-types"),
  seedPaymentSplit: () =>
    request<{ created: string[]; skipped: string[]; createdCount: number }>(
      "POST", "/sequences/seed-payment-split", {}),
};
