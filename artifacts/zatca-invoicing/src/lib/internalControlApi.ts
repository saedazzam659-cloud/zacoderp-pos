// Internal Control (الرقابة الداخلية) client — mirrors .local/internal-control-contract.md.
// Read-only review layer: nothing here mutates financial documents.
const API_BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
const ROOT = `${API_BASE}/api/internal-control`;

export type IcSeverity = "low" | "medium" | "high" | "critical";
export type IcStatus = "open" | "in_review" | "resolved" | "ignored";
export type IcAction = "review" | "resolve" | "ignore" | "reopen" | "note" | "assign";

export interface IcCase {
  id: number; companyId: number; branchId: number | null; ruleKey: string; eventKey: string | null;
  category: string | null; source: string | null; documentType: string | null; documentId: number | string | null;
  documentNumber: string | null; projectId: number | null; customerId: number | null; supplierId: number | null;
  userId: number | null; approverId: number | null; occurredAt: string | null; description: string | null;
  reason: string | null; severity: IcSeverity; status: IcStatus; reviewerId: number | null;
  reviewerNotes: string | null; actionTaken: string | null; resolvedAt: string | null; documentUrl: string | null;
  createdAt: string; updatedAt: string;
}
export interface IcHistory {
  id: number; caseId: number | null; companyId: number; userId: number | null; action: string;
  fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string;
}
export interface IcRule {
  key: string; name: string; module: string | null; category: string | null; severity: IcSeverity;
  enabled: boolean; threshold: number | null; excludedUserIds: number[] | null; excludedRoles: string[] | null;
  supported: boolean; unsupportedReason: string | null; thresholdUnit: string | null;
}
export interface IcMetrics {
  total: number; open: number; highRisk: number; inReview: number; resolved: number; postApproval: number;
  permissions: number; cancelled: number; projects: number; inventory: number; finance: number;
  guarantees: number; advances: number;
}
export interface IcPage<T> { items: T[]; total: number; page: number; limit: number }

export interface IcFilters {
  branchId?: string; userId?: string; category?: string; projectId?: string; customerId?: string;
  supplierId?: string; from?: string; to?: string; severity?: string; status?: string;
  page?: number; limit?: number;
}

function headers(json = true): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function icQuery(f: IcFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "" || v === "all") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, { credentials: "include", ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(res.status >= 500 ? "تعذر تنفيذ الطلب. يرجى المحاولة لاحقًا." : body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const icApi = {
  lookups: () => req<{users:any[];branches:any[]}>("/lookups"),
  dashboard: (f: IcFilters) => req<{ metrics: IcMetrics; capabilities: Record<string, unknown> }>(`/dashboard${icQuery(f)}`),
  cases: (f: IcFilters) => req<IcPage<IcCase>>(`/cases${icQuery(f)}`),
  case: (id: number | string) => req<{ case: IcCase; history: IcHistory[]; evidence: Record<string, unknown> | null }>(`/cases/${id}`),
  act: (id: number, body: { action: IcAction; note?: string; reviewerId?: number; actionTaken?: string }) =>
    req<{ case: IcCase }>(`/cases/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  rules: () => req<{ items: IcRule[] }>(`/rules`),
  saveRule: (key: string, body: Partial<Pick<IcRule, "enabled" | "severity" | "threshold" | "excludedUserIds" | "excludedRoles">>) =>
    req<unknown>(`/rules/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(body) }),
  scan: () => req<{ created?: number; evaluated?: number; errors?: unknown }>(`/scan`, { method: "POST" }),
  log: (f: IcFilters) => req<IcPage<IcHistory>>(`/log${icQuery(f)}`),
  async exportCsv(f: IcFilters): Promise<void> {
    const { page: _p, limit: _l, ...rest } = f;
    const res = await fetch(`${ROOT}/export${icQuery(rest)}`, { credentials: "include", headers: headers(false) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(res.status >= 500 ? "تعذر التصدير. يرجى المحاولة لاحقًا." : body?.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `internal-control-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

export const SEVERITY_LABEL: Record<IcSeverity, string> = { low: "منخفضة", medium: "متوسطة", high: "عالية", critical: "حرجة" };
export const STATUS_LABEL: Record<IcStatus, string> = { open: "مفتوحة", in_review: "قيد المراجعة", resolved: "تمت المعالجة", ignored: "تم تجاهلها" };
export const ACTION_LABEL: Record<string, string> = {
  review: "بدء المراجعة", resolve: "معالجة", ignore: "تجاهل", reopen: "إعادة فتح", note: "ملاحظة", assign: "إسناد",
  create: "إنشاء الحالة", created: "إنشاء الحالة", scan: "فحص",
  rule_updated: "تعديل قاعدة",
};
