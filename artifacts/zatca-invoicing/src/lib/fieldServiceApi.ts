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

// ─── Types ─────────────────────────────────────────────────────────────
export interface FieldLocation {
  id: number;
  name: string;
  type: string;       // office | branch | customer | project | asset | warehouse | supplier | other
  lat: string; lng: string; radiusM: number;
  customerId?: number | null; projectId?: number | null; assetId?: number | null;
  costCenterId?: number | null;
  branchId?: number | null;
  address?: string | null; city?: string | null;
  contactPerson?: string | null; contactPhone?: string | null;
  isActive: boolean; notes?: string | null;
  createdAt: string; updatedAt: string;
}

export interface FieldVisit {
  id: number;
  employeeId: number;
  employeeName?: string;
  employeeCode?: string;
  employeePhotoUrl?: string | null;
  locationId: number | null;
  locationName: string | null;
  locationType: string | null;
  customerId?: number | null;
  ticketId?: number | null;
  purpose: string;
  status: "open" | "completed" | "cancelled";
  arrivedAt: string;
  leftAt: string | null;
  durationMin: number | null;
  arrivalLat: string | null; arrivalLng: string | null;
  arrivalDistanceM: string | null; arrivalLocStatus: string | null;
  departureLat?: string | null; departureLng?: string | null;
  outcome?: string | null;
  photoUrl?: string | null; signatureUrl?: string | null; signedByName?: string | null;
  notes?: string | null;
}

export interface FieldVisitPlan {
  id: number;
  employeeId: number;
  employeeName?: string;
  date: string;
  status: string;
  notes?: string | null;
  createdAt?: string;
}

export interface FieldVisitPlanItem {
  id: number;
  sequenceNo: number;
  locationId: number | null;
  locationName: string | null;
  plannedAt: string | null;
  purpose: string | null;
  status: "pending" | "done" | "skipped";
  visitId?: number | null;
  notes?: string | null;
  lat?: string | null; lng?: string | null;
  address?: string | null;
  radiusM?: number | null;
}

export interface FieldServiceTicket {
  id: number;
  ticketNo: string;
  title: string;
  description?: string | null;
  category: string;
  priority: "low" | "medium" | "high" | "urgent";
  status: string;
  openedAt: string;
  respondedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  slaResponseMin: number;
  slaResolutionMin: number;
  slaResponseBreached: boolean;
  slaResolutionBreached: boolean;
  customerId?: number | null;
  customerName?: string | null;
  assetId?: number | null;
  locationId?: number | null;
  assignedTo?: number | null;
  assignedToName?: string | null;
  resolution?: string | null;
  customerRating?: number | null;
  laborHours?: string | null; laborCost?: string | null;
  partsCost?: string | null; totalCost?: string | null;
  notes?: string | null;
  visits?: FieldVisit[];
}

export interface SummaryRow {
  employeeId: number; employeeName: string;
  totalVisits: number; completedVisits: number; openVisits: number;
  totalMinutes: number; flaggedVisits: number; uniqueLocations: number;
}

export interface SlaSummary {
  total: number; open: number; resolved: number;
  respBreached: number; resBreached: number;
  avgResponseMin: number; avgResolutionMin: number; avgRating: number;
}

export interface LiveTrackingRow {
  employee_id: number; employee_name: string; employee_code: string;
  employee_photo_url: string | null;
  visit_id: number; status: string; location_name: string | null;
  arrived_at: string; left_at: string | null;
  arrival_lat: string | null; arrival_lng: string | null;
  departure_lat: string | null; departure_lng: string | null;
  purpose: string | null; duration_min: number | null;
}

// ─── API ───────────────────────────────────────────────────────────────
export const fieldApi = {
  // Locations
  listLocations: (params: { type?: string; includeInactive?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.type) q.set("type", params.type);
    if (params.includeInactive) q.set("includeInactive", "1");
    const s = q.toString();
    return req<FieldLocation[]>("GET", `/hr/field/locations${s ? "?" + s : ""}`);
  },
  createLocation: (body: Partial<FieldLocation> & { name: string; lat: number; lng: number }) =>
    req<FieldLocation>("POST", `/hr/field/locations`, body),
  updateLocation: (id: number, body: Partial<FieldLocation>) =>
    req<FieldLocation>("PATCH", `/hr/field/locations/${id}`, body),
  deleteLocation: (id: number) => req<{ ok: true }>("DELETE", `/hr/field/locations/${id}`),
  importCustomers: () => req<{ imported: number; total: number }>("POST", `/hr/field/locations/import-customers`),

  // Visits
  startVisit: (body: {
    employeeId: number; locationId?: number | null;
    lat?: number | null; lng?: number | null; accuracy?: number | null; mocked?: boolean;
    purpose?: string; ticketId?: number; planItemId?: number; notes?: string;
    customerId?: number; projectId?: number; assetId?: number; costCenterId?: number;
    photoUrl?: string;
  }) => req<FieldVisit>("POST", `/hr/field/visits/start`, body),
  endVisit: (id: number, body: {
    employeeId?: number;
    lat?: number | null; lng?: number | null; accuracy?: number | null;
    outcome?: string; notes?: string;
    signatureUrl?: string; signedByName?: string;
    resolveTicket?: boolean; resolution?: string;
  }) => req<FieldVisit>("POST", `/hr/field/visits/${id}/end`, body),
  cancelVisit: (id: number, body: { employeeId?: number; notes?: string } = {}) =>
    req<FieldVisit>("POST", `/hr/field/visits/${id}/cancel`, body),
  listVisits: (params: { employeeId?: number; status?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.employeeId) q.set("employeeId", String(params.employeeId));
    if (params.status) q.set("status", params.status);
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    const s = q.toString();
    return req<FieldVisit[]>("GET", `/hr/field/visits${s ? "?" + s : ""}`);
  },
  todayVisits: (employeeId: number) =>
    req<FieldVisit[]>("GET", `/hr/field/visits/today/${employeeId}`),

  // Plans
  listPlans: (params: { employeeId?: number; date?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.employeeId) q.set("employeeId", String(params.employeeId));
    if (params.date) q.set("date", params.date);
    const s = q.toString();
    return req<FieldVisitPlan[]>("GET", `/hr/field/plans${s ? "?" + s : ""}`);
  },
  getPlan: (id: number) =>
    req<FieldVisitPlan & { items: FieldVisitPlanItem[] }>("GET", `/hr/field/plans/${id}`),
  createPlan: (body: {
    employeeId: number; date: string; status?: string; notes?: string;
    items: Array<{ locationId?: number | null; sequenceNo?: number; plannedAt?: string; purpose?: string; notes?: string }>;
  }) => req<FieldVisitPlan>("POST", `/hr/field/plans`, body),
  deletePlan: (id: number) => req<{ ok: true }>("DELETE", `/hr/field/plans/${id}`),
  todayPlan: (employeeId: number) =>
    req<{ plan: FieldVisitPlan | null; items: FieldVisitPlanItem[] }>("GET", `/hr/field/plans/today/${employeeId}`),

  // Tickets
  listTickets: (params: { status?: string; assignedTo?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.assignedTo) q.set("assignedTo", String(params.assignedTo));
    const s = q.toString();
    return req<FieldServiceTicket[]>("GET", `/hr/field/tickets${s ? "?" + s : ""}`);
  },
  getTicket: (id: number) => req<FieldServiceTicket>("GET", `/hr/field/tickets/${id}`),
  createTicket: (body: Partial<FieldServiceTicket> & { title: string }) =>
    req<FieldServiceTicket>("POST", `/hr/field/tickets`, body),
  updateTicket: (id: number, body: Partial<FieldServiceTicket>) =>
    req<FieldServiceTicket>("PATCH", `/hr/field/tickets/${id}`, body),
  assignTicket: (id: number, employeeId: number) =>
    req<FieldServiceTicket>("POST", `/hr/field/tickets/${id}/assign`, { employeeId }),
  resolveTicket: (id: number, resolution?: string) =>
    req<FieldServiceTicket>("POST", `/hr/field/tickets/${id}/resolve`, { resolution }),
  closeTicket: (id: number, customerRating?: number) =>
    req<FieldServiceTicket>("POST", `/hr/field/tickets/${id}/close`, { customerRating }),

  // Reports
  summary: (params: { employeeId?: number; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.employeeId) q.set("employeeId", String(params.employeeId));
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    const s = q.toString();
    return req<{ from: string; to: string; rows: SummaryRow[] }>("GET", `/hr/field/reports/summary${s ? "?" + s : ""}`);
  },
  sla: (params: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    const s = q.toString();
    return req<{ from: string; to: string; summary: SlaSummary; byPriority: Array<{ priority: string; total: number; respBreached: number; resBreached: number }> }>(
      "GET", `/hr/field/reports/sla${s ? "?" + s : ""}`,
    );
  },
  liveTracking: () => req<LiveTrackingRow[]>("GET", `/hr/field/tracking/live`),
};
