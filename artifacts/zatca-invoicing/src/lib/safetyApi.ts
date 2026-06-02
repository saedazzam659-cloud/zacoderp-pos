// Occupational Safety & Health (OSH) client — mirrors fieldServiceApi.ts.
const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const session = localStorage.getItem("zatca_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) headers.Authorization = `Bearer ${session}`;
  const acting = localStorage.getItem("zatca_acting_company_id");
  if (acting) headers["x-acting-company-id"] = acting;
  return headers;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? (undefined as any) : r.json();
}

// ─── Enums (mirror lib/db/src/schema/safety.ts) ──────────────────────────
export const HAZARD_CATEGORIES = [
  "mechanical", "electrical", "chemical", "ergonomic", "biological",
  "physical", "psychosocial", "fire", "fall", "environmental", "other",
] as const;
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const RISK_STATUSES = ["open", "in_review", "controlled", "closed"] as const;
export const CONTROL_TYPES = ["elimination", "substitution", "engineering", "administrative", "ppe"] as const;
export const CONTROL_STATUSES = ["planned", "in_progress", "done"] as const;
export const INCIDENT_TYPES = [
  "near_miss", "unsafe_condition", "property_damage", "injury", "occupational_illness", "environmental",
] as const;
export const SEVERITY_CLASSES = ["no_treatment", "first_aid", "medical_treatment", "lost_time", "fatality"] as const;
export const INCIDENT_STATUSES = ["open", "investigating", "action_pending", "closed"] as const;
export const ACTION_TYPES = ["corrective", "preventive"] as const;
export const ACTION_STATUSES = ["open", "in_progress", "done"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

// ─── Types ───────────────────────────────────────────────────────────────
export interface RiskControl {
  id: number;
  companyId: number;
  assessmentId: number;
  controlType: string;
  description: string;
  status: string;
  ownerUserId: number | null;
  dueDate: string | null;
  createdAt: string;
}

export interface RiskAssessment {
  id: number;
  companyId: number;
  branchId: number | null;
  code: string;
  title: string;
  processArea: string | null;
  workCenterId: number | null;
  workCenterName?: string | null;
  hazardDescription: string | null;
  hazardCategory: string;
  likelihood: number;
  severity: number;
  riskScore: number;
  riskLevel: RiskLevel;
  existingControls: string | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
  residualScore: number | null;
  residualLevel: RiskLevel | null;
  responsibleUserId: number | null;
  responsibleName?: string | null;
  assessmentDate: string | null;
  reviewDate: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  controls?: RiskControl[];
}

export interface IncidentAction {
  id: number;
  companyId: number;
  incidentId: number;
  actionType: string;
  description: string;
  ownerUserId: number | null;
  dueDate: string | null;
  status: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Incident {
  id: number;
  companyId: number;
  branchId: number | null;
  incidentNumber: string;
  incidentType: string;
  severityClass: string;
  title: string;
  description: string | null;
  location: string | null;
  workCenterId: number | null;
  workCenterName?: string | null;
  productionOrderId: number | null;
  injuredEmployeeId: number | null;
  employeeName?: string | null;
  occurredAt: string;
  reportedAt: string;
  reportedByUserId: number | null;
  immediateActions: string | null;
  rootCause: string | null;
  whys: string[];
  lostDays: number;
  isRecordable: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
  actions?: IncidentAction[];
}

export interface SafetyKpis {
  manHours: number | null;
  incidents: {
    total: number; nearMiss: number; recordable: number;
    lostTime: number; fatalities: number; open: number; totalLostDays: number;
  };
  daysSinceLastLti: number | null;
  rates: { trir: number | null; ltifr: number | null; severityRate: number | null };
  risks: { byLevel: Record<string, number>; open: number; total: number };
  capa: { open: number; overdue: number; total: number };
}

// ─── API ───────────────────────────────────────────────────────────────
export const safetyApi = {
  // Risk assessments
  listRiskAssessments: (params: { status?: string; q?: string } = {}) => {
    const s = new URLSearchParams();
    if (params.status) s.set("status", params.status);
    if (params.q) s.set("q", params.q);
    const qs = s.toString();
    return req<RiskAssessment[]>("GET", `/safety/risk-assessments${qs ? "?" + qs : ""}`);
  },
  getRiskAssessment: (id: number) =>
    req<RiskAssessment>("GET", `/safety/risk-assessments/${id}`),
  createRiskAssessment: (body: Partial<RiskAssessment> & { title: string }) =>
    req<RiskAssessment>("POST", `/safety/risk-assessments`, body),
  updateRiskAssessment: (id: number, body: Partial<RiskAssessment>) =>
    req<RiskAssessment>("PATCH", `/safety/risk-assessments/${id}`, body),
  deleteRiskAssessment: (id: number) =>
    req<{ ok: true }>("DELETE", `/safety/risk-assessments/${id}`),

  addControl: (raId: number, body: Partial<RiskControl> & { description: string }) =>
    req<RiskControl>("POST", `/safety/risk-assessments/${raId}/controls`, body),
  updateControl: (id: number, body: Partial<RiskControl>) =>
    req<RiskControl>("PATCH", `/safety/controls/${id}`, body),
  deleteControl: (id: number) => req<{ ok: true }>("DELETE", `/safety/controls/${id}`),

  // Incidents
  listIncidents: (params: { status?: string; type?: string; q?: string } = {}) => {
    const s = new URLSearchParams();
    if (params.status) s.set("status", params.status);
    if (params.type) s.set("type", params.type);
    if (params.q) s.set("q", params.q);
    const qs = s.toString();
    return req<Incident[]>("GET", `/safety/incidents${qs ? "?" + qs : ""}`);
  },
  getIncident: (id: number) => req<Incident>("GET", `/safety/incidents/${id}`),
  createIncident: (body: Partial<Incident> & { title: string; occurredAt: string }) =>
    req<Incident>("POST", `/safety/incidents`, body),
  updateIncident: (id: number, body: Partial<Incident>) =>
    req<Incident>("PATCH", `/safety/incidents/${id}`, body),
  deleteIncident: (id: number) => req<{ ok: true }>("DELETE", `/safety/incidents/${id}`),

  addAction: (incId: number, body: Partial<IncidentAction> & { description: string }) =>
    req<IncidentAction>("POST", `/safety/incidents/${incId}/actions`, body),
  updateAction: (id: number, body: Partial<IncidentAction>) =>
    req<IncidentAction>("PATCH", `/safety/actions/${id}`, body),
  deleteAction: (id: number) => req<{ ok: true }>("DELETE", `/safety/actions/${id}`),

  // KPIs
  kpis: (params: { manHours?: number } = {}) => {
    const s = new URLSearchParams();
    if (params.manHours) s.set("manHours", String(params.manHours));
    const qs = s.toString();
    return req<SafetyKpis>("GET", `/safety/kpis${qs ? "?" + qs : ""}`);
  },
};
