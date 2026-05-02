// Client wrappers for /api/security-ai, /api/security-reports, and the
// AI-related extensions to /api/surveillance-devices.
const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST", headers: authHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function del<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export interface SurveillanceDevice {
  id: number;
  companyId: number;
  branchId: number | null;
  code: string;
  nameAr: string;
  nameEn: string | null;
  deviceType: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  location: string | null;
  ipAddress: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  streamProtocol: string | null;
  streamUrl: string | null;
  channelNumber: number | null;
  channelsCount: number | null;
  parentDeviceId: number | null;
  status: string;
  locationType: string | null;
  departmentId: number | null;
  productionLineId: number | null;
  warehouseId: number | null;
  employeeId: number | null;
  notes: string | null;
}

export interface SecurityInsights {
  days: number;
  total: number;
  byModule: Array<{ k: string; c: number }>;
  bySource: Array<{ k: string; c: number }>;
  topTypes: Array<{ k: string; c: number }>;
  topBranches: Array<{ k: number | null; c: number }>;
  topCameras: Array<{ k: number | null; c: number }>;
  mttrHours: number | null;
  actionsBy: Array<{ k: string; c: number }>;
}

export interface SecurityAnalysis {
  eventId: number;
  riskScore: number;
  level: "low" | "medium" | "high" | "critical";
  reasons: string[];
  action: { kind: string; targetModule: string; title: string; details: string };
}

export interface SecurityAction {
  id: number;
  companyId: number;
  eventId: number | null;
  kind: string;
  targetModule: string;
  targetRefId: number | null;
  title: string;
  details: string | null;
  status: string;
  payload: any;
  createdAt: string;
}

export const surveillanceDevicesApi = {
  list:   (params?: { type?: string; branchId?: number }) => {
    const q = new URLSearchParams();
    if (params?.type) q.set("type", params.type);
    if (params?.branchId) q.set("branchId", String(params.branchId));
    return get<SurveillanceDevice[]>(`/api/surveillance-devices?${q.toString()}`);
  },
  get:    (id: number) => get<SurveillanceDevice>(`/api/surveillance-devices/${id}`),
  create: (b: Partial<SurveillanceDevice>) => post<SurveillanceDevice>(`/api/surveillance-devices`, b),
  update: (id: number, b: Partial<SurveillanceDevice>) => put<SurveillanceDevice>(`/api/surveillance-devices/${id}`, b),
  remove: (id: number) => del<{ ok: true }>(`/api/surveillance-devices/${id}`),
};

export const securityAiApi = {
  insights: (days = 30) => get<SecurityInsights>(`/api/security-ai/insights?days=${days}`),
  heatmap:  (days = 30) => get<{ days: number; grid: number[][] }>(`/api/security-ai/heatmap?days=${days}`),
  analyze:  (eventId: number) => get<SecurityAnalysis>(`/api/security-ai/analyze/${eventId}`),
  dispatch: (b: { eventId: number; kind: string; targetModule: string; title: string; details?: string; targetRefId?: number | null }) =>
    post<SecurityAction>(`/api/security-ai/dispatch`, b),
  actions:  (params?: { module?: string; eventId?: number }) => {
    const q = new URLSearchParams();
    if (params?.module)  q.set("module", params.module);
    if (params?.eventId) q.set("eventId", String(params.eventId));
    return get<SecurityAction[]>(`/api/security-ai/actions?${q.toString()}`);
  },
  evaluateRules: () => post<{ generated: number; events: any[] }>(`/api/security-ai/evaluate-rules`, {}),
};

export const securityReportsApi = {
  hrCompliance: (days = 30) => get<{ since: string; items: Array<{ employeeId: number; total: number; open: number; critical: number; high: number; lastAt: string | null }> }>(`/api/security-reports/hr-compliance?days=${days}`),
  productionDowntime: (days = 30) => get<{ since: string; items: Array<{ productionLineId: number; total: number; open: number; stops: number; lastAt: string | null }> }>(`/api/security-reports/production-downtime?days=${days}`),
  warehouseNight: (days = 30, startHour = 22, endHour = 6) => get<{ since: string; startHour: number; endHour: number; items: Array<{ warehouseId: number; total: number; critical: number; lastAt: string | null }> }>(`/api/security-reports/warehouse-night?days=${days}&startHour=${startHour}&endHour=${endHour}`),
  branchComparison: (days = 30) => get<{ since: string; items: Array<{ branchId: number | null; total: number; critical: number; open: number; cameras: number }> }>(`/api/security-reports/branch-comparison?days=${days}`),
  actionsSummary: (days = 30) => get<{ since: string; items: Array<{ kind: string; targetModule: string; total: number }> }>(`/api/security-reports/actions-summary?days=${days}`),
};
