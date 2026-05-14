const API = import.meta.env.VITE_API_URL ?? "";

// LocalStorage key for the kiosk pairing token. When present, the device
// authenticates as a kiosk (via X-Kiosk-Token) instead of a user session.
// A user session takes priority if both happen to exist on the same browser.
export const KIOSK_TOKEN_KEY = "zatca_kiosk_token";

function authHeaders(): Record<string, string> {
  const session = localStorage.getItem("zatca_token");
  if (session) {
    return { Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
  }
  const kiosk = localStorage.getItem(KIOSK_TOKEN_KEY);
  if (kiosk) {
    return { "X-Kiosk-Token": kiosk, "Content-Type": "application/json" };
  }
  return { "Content-Type": "application/json" };
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

export interface Camera {
  id: number;
  name: string;
  location?: string | null;
  kind: string;
  branchId?: number | null;
  branchName?: string | null;
  dvrIp?: string | null;
  port?: number | null;
  channel?: number | null;
  protocol?: string | null;
  streamUrl?: string | null;
  aiEnabled: boolean;
  status: string;
  lastSeenAt?: string | null;
  notes?: string | null;
}

export interface Enrollment {
  id: number;
  employeeId: number;
  employeeName: string | null;
  employeeCode: string | null;
  qualityScore: string;
  pose: string;
  livenessPassed: boolean;
  isPrimary: boolean;
  capturedAt: string;
  imageUrl?: string | null;
}

export interface RecognizeResult {
  matched: boolean;
  employeeId: number | null;
  employeeName: string | null;
  employeeCode: string | null;
  employeePhotoUrl: string | null;
  distance?: number;
  confidence?: number;
  threshold?: number;
  reason?: string;
  ticket?: string | null;
}

export interface FaceLog {
  id: number;
  employeeId: number | null;
  employeeName: string | null;
  employeeCode: string | null;
  cameraId: number | null;
  cameraName: string | null;
  action: string | null;
  status: string;
  matchedConfidence: string | null;
  livenessPassed: boolean;
  spoofReason: string | null;
  deviceInfo: string | null;
  createdAt: string;
}

export interface FaceSettings {
  matchThreshold: string;
  cooldownSeconds: number;
  requireLiveness: boolean;
  autoCheckOut: boolean;
  lateToleranceMin: number;
  workdayStart: string | null;
  workdayEnd: string | null;
  notifyOnUnknown: boolean;
  minQualityScore: string;
}

export interface FaceAnalytics {
  totalEmployees: number;
  enrolledEmployees: number;
  enrollmentRate: number;
  camerasCount: number;
  todayPresent: number;
  todayLate: number;
  presenceRate: number;
  weekRecognitions: number;
  weekSpoofs: number;
  topLate: Array<{ employeeId: number; employeeName: string | null; employeeCode: string | null; lateDays: number; totalLateMin: number }>;
  heatmap: Array<{ hour: number; cnt: number }>;
}

export const faceApi = {
  // settings
  getSettings: () => req<FaceSettings>("GET", "/hr/face/settings"),
  updateSettings: (data: Partial<FaceSettings>) => req<FaceSettings>("PUT", "/hr/face/settings", data),

  // cameras
  cameras: () => req<Camera[]>("GET", "/hr/face/cameras"),
  createCamera: (data: Partial<Camera> & { password?: string }) => req<Camera>("POST", "/hr/face/cameras", data),
  updateCamera: (id: number, data: Partial<Camera> & { password?: string }) => req<Camera>("PUT", `/hr/face/cameras/${id}`, data),
  deleteCamera: (id: number) => req<{ ok: boolean }>("DELETE", `/hr/face/cameras/${id}`),
  pingCamera: (id: number) => req<{ ok: boolean; message: string }>("POST", `/hr/face/cameras/${id}/ping`),

  // enrollments
  enrollments: (employeeId?: number) =>
    req<Enrollment[]>("GET", `/hr/face/enrollments${employeeId ? `?employeeId=${employeeId}` : ""}`),
  enroll: (data: { employeeId: number; descriptor: number[]; qualityScore: number; pose?: string; livenessPassed: boolean; imageUrl?: string }) =>
    req<Enrollment>("POST", "/hr/face/enrollments", data),
  deleteEnrollment: (id: number) => req<{ ok: boolean }>("DELETE", `/hr/face/enrollments/${id}`),

  // recognize / check
  recognize: (descriptor: number[], cameraId?: number | null, livenessPassed?: boolean) =>
    req<RecognizeResult>("POST", "/hr/face/recognize", { descriptor, cameraId, livenessPassed: !!livenessPassed }),
  // Server-side identity comes from the signed `ticket` returned by /recognize.
  // Client cannot inject employeeId, confidence, livenessPassed, or cameraId here.
  check: (data: {
    ticket: string;
    action?: "auto" | "check_in" | "check_out";
    deviceInfo?: string;
    location?: { lat: number | null; lng: number | null; accuracy: number | null; mocked?: boolean };
  }) =>
    req<{
      ok: boolean;
      action?: string;
      attendanceId?: number;
      logId?: number;
      lateMinutes?: number;
      reason?: string;
      cooldownSeconds?: number;
      location?: {
        status: "ok" | "out_of_geofence" | "low_accuracy" | "mock_suspected" | "denied" | "no_gps";
        distanceM: number | null;
        flagged: boolean;
        radiusM: number;
        hasWorkLocation: boolean;
      };
    }>("POST", "/hr/face/check", data),

  // ── Work locations (admin) ──────────────────────────────────────────
  workLocations: () =>
    req<Array<{
      id: number; code: string; nameAr: string;
      department: string | null; jobTitle: string | null; photoUrl: string | null;
      workLat: string | null; workLng: string | null; workRadiusM: number | null;
    }>>("GET", "/hr/face/employees/work-locations"),
  setWorkLocation: (employeeId: number, data: { lat: number | null; lng: number | null; radiusM: number | null }) =>
    req<{ id: number; workLat: string | null; workLng: string | null; workRadiusM: number | null }>(
      "PATCH",
      `/hr/face/employees/${employeeId}/work-location`,
      data,
    ),

  // ── Approvals queue ─────────────────────────────────────────────────
  approvals: (status: "pending" | "approved" | "rejected" | "all" = "pending") =>
    req<Array<ApprovalRow>>("GET", `/hr/face/approvals?status=${status}`),
  decideApproval: (id: number, decision: "approved" | "rejected", note?: string) =>
    req<{ ok: boolean; id: number; status: string }>(
      "POST",
      `/hr/face/approvals/${id}/decide`,
      { decision, note },
    ),

  // ── Activity timeline ───────────────────────────────────────────────
  timeline: (employeeId: number, from: string, to: string) =>
    req<TimelineResponse>(
      "GET",
      `/hr/face/timeline?employeeId=${employeeId}&from=${from}&to=${to}`,
    ),

  // logs / analytics
  logs: (status?: string) => req<FaceLog[]>("GET", `/hr/face/logs${status ? `?status=${status}` : ""}`),
  recent: (limit = 20) => req<FaceLog[]>("GET", `/hr/face/recent?limit=${limit}`),
  analytics: () => req<FaceAnalytics>("GET", "/hr/face/analytics"),

  // AI weekly summary — falls back to caller's local summary if proxy is off.
  aiSummary: (analytics: FaceAnalytics) =>
    req<{ summary: string; source: "ai" }>("POST", "/ai/summarize-face-attendance", analytics),

  // ── Kiosk pairing ───────────────────────────────────────────────────
  kioskMe: () =>
    req<{ id: number; label: string; companyId: number }>("GET", "/hr/face/kiosk/me"),
  listKioskTokens: () =>
    req<KioskTokenSummary[]>("GET", "/hr/face/kiosk-tokens"),
  createKioskToken: (label: string) =>
    req<KioskTokenCreated>("POST", "/hr/face/kiosk-tokens", { label }),
  revokeKioskToken: (id: number) =>
    req<{ ok: boolean }>("DELETE", `/hr/face/kiosk-tokens/${id}`),
};

export interface ApprovalRow {
  id: number;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  employeeId: number;
  employeeName: string | null;
  employeeCode: string | null;
  employeePhotoUrl: string | null;
  checkInLat: string | null;
  checkInLng: string | null;
  checkInDistanceM: string | null;
  checkInLocStatus: string | null;
  checkOutLat: string | null;
  checkOutLng: string | null;
  checkOutDistanceM: string | null;
  checkOutLocStatus: string | null;
  workLat: string | null;
  workLng: string | null;
  workRadiusM: number | null;
  approvalStatus: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  approvalNote: string | null;
}

export interface TimelineResponse {
  employee: {
    id: number;
    nameAr: string;
    code: string;
    photoUrl: string | null;
    department: string | null;
    jobTitle: string | null;
    workLat: string | null;
    workLng: string | null;
    workRadiusM: number | null;
  };
  range: { from: string; to: string };
  attendance: Array<{
    id: number;
    date: string;
    checkIn: string | null;
    checkOut: string | null;
    workedHours: string | null;
    overtimeHours: string | null;
    lateMinutes: number | null;
    status: string;
    needsApproval: boolean;
    approvalStatus: string | null;
    checkInLocStatus: string | null;
    checkOutLocStatus: string | null;
    checkInDistanceM: string | null;
    checkOutDistanceM: string | null;
  }>;
  activity: Array<{
    id: number;
    action: string | null;
    status: string;
    cameraId: number | null;
    cameraName: string | null;
    matchedConfidence: string | null;
    createdAt: string;
  }>;
  totals: {
    workedHours: number;
    overtimeHours: number;
    lateMinutes: number;
    daysPresent: number;
    flagged: number;
    activityCount: number;
  };
}

export interface KioskTokenSummary {
  id: number;
  label: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdByUserId: number | null;
  createdByName: string | null;
}

export interface KioskTokenCreated {
  id: number;
  label: string;
  scope: string;
  createdAt: string;
  token: string;
  pairUrl: string;
}
