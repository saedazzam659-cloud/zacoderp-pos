const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  const acting = localStorage.getItem("zatca_acting_company_id");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  if (acting) h["x-acting-company-id"] = acting;
  return h;
}
function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") sp.set(k, String(v)); });
  const s = sp.toString();
  return s ? `?${s}` : "";
}
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}/api/user-tracking${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return undefined as any;
  return r.json();
}

export type VisitRow = {
  id: number; userId: number; userName: string;
  branchId: number | null; branchName: string | null;
  purpose: string | null; notes: string | null; status: string;
  checkinAt: string; checkinLat: string | null; checkinLng: string | null;
  checkinPlace: string | null; checkinAddress: string | null;
  checkoutAt: string | null; checkoutLat: string | null; checkoutLng: string | null;
  checkoutPlace: string | null; checkoutAddress: string | null;
  durationMinutes: number | null;
  zoneId: number | null; alertFlags: string | null;
};
export type DashboardData = {
  totals: { visitCount: number; totalMinutes: number; activeUsers: number; alertCount: number };
  perUser: Array<{ userId: number; userName: string; visitCount: number; completedCount: number; activeCount: number; totalMinutes: number; avgMinutes: number; alertCount: number; distinctPlaces: number }>;
  perDay: Array<{ day: string; visitCount: number; totalMinutes: number }>;
  topPlaces: Array<{ place: string; visitCount: number; totalMinutes: number }>;
};
export type TrackingZone = {
  id: number; name: string; centerLat: string; centerLng: string;
  radiusMeters: number; isAllowed: boolean; isActive: boolean; notes: string | null;
};

export const userTrackingApi = {
  config:   () => req<{ mapboxConfigured: boolean }>(`/config`),
  active:   (companyId?: number) => req<VisitRow | null>(`/active${qs({ companyId })}`),
  meStatus: (companyId?: number) => req<{ isAssignedToZone: boolean; activeVisitId: number | null; zones: Array<{ id: number; name: string }> }>(`/me-status${qs({ companyId })}`),
  checkin:  (body: { lat: number; lng: number; accuracy?: number; purpose?: string; notes?: string; branchId?: number }, companyId?: number) =>
    req<VisitRow>(`/checkin${qs({ companyId })}`, { method: "POST", body: JSON.stringify(body) }),
  checkout: (id: number, body: { lat: number; lng: number; accuracy?: number; notes?: string }, companyId?: number) =>
    req<VisitRow>(`/visits/${id}/checkout${qs({ companyId })}`, { method: "POST", body: JSON.stringify(body) }),
  cancel:   (id: number, companyId?: number) =>
    req<VisitRow>(`/visits/${id}/cancel${qs({ companyId })}`, { method: "POST", body: "{}" }),
  visits:   (params: { companyId?: number; from?: string; to?: string; userId?: number; status?: string; limit?: number }) =>
    req<VisitRow[]>(`/visits${qs(params)}`),
  dashboard:(params: { companyId?: number; from?: string; to?: string; userId?: number }) =>
    req<DashboardData>(`/dashboard${qs(params)}`),
  zones:    (companyId?: number) => req<TrackingZone[]>(`/zones${qs({ companyId })}`),
  createZone: (body: { name: string; centerLat: number; centerLng: number; radiusMeters?: number; isAllowed?: boolean; isActive?: boolean; notes?: string }, companyId?: number) =>
    req<TrackingZone>(`/zones${qs({ companyId })}`, { method: "POST", body: JSON.stringify(body) }),
  updateZone: (id: number, body: { name?: string; centerLat?: number; centerLng?: number; radiusMeters?: number; isAllowed?: boolean; isActive?: boolean; notes?: string }, companyId?: number) =>
    req<TrackingZone>(`/zones/${id}${qs({ companyId })}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteZone: (id: number, companyId?: number) =>
    req<void>(`/zones/${id}${qs({ companyId })}`, { method: "DELETE" }),

  // User ↔ zone assignment
  zoneUsers: (zoneId: number, companyId?: number) =>
    req<Array<{ userId: number; userName: string; username: string; assignedAt: string }>>(`/zones/${zoneId}/users${qs({ companyId })}`),
  assignUserToZone: (zoneId: number, userId: number, companyId?: number) =>
    req<{ zoneId: number; userId: number }>(`/zones/${zoneId}/users${qs({ companyId })}`, { method: "POST", body: JSON.stringify({ userId }) }),
  unassignUserFromZone: (zoneId: number, userId: number, companyId?: number) =>
    req<void>(`/zones/${zoneId}/users/${userId}${qs({ companyId })}`, { method: "DELETE" }),
  companyUsers: (companyId?: number) =>
    req<Array<{ id: number; username: string; name: string }>>(`/company-users${qs({ companyId })}`),

  // Forward-geocode: place name → coordinates (uses free OSM Nominatim)
  geocode: (q: string, companyId?: number) =>
    req<Array<{ displayName: string; lat: number; lng: number; type: string; importance: number }>>(`/geocode${qs({ q, companyId })}`),
};

// Browser geolocation helper. Returns Promise<{lat,lng,accuracy}> or rejects.
export function getCurrentPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("المتصفح لا يدعم تحديد الموقع")); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error(err.message || "فشل تحديد الموقع")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
