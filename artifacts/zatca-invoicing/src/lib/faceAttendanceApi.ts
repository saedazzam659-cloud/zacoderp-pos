const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
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
  check: (data: { ticket: string; action?: "auto" | "check_in" | "check_out"; deviceInfo?: string }) =>
    req<{ ok: boolean; action?: string; attendanceId?: number; logId?: number; lateMinutes?: number; reason?: string; cooldownSeconds?: number }>("POST", "/hr/face/check", data),

  // logs / analytics
  logs: (status?: string) => req<FaceLog[]>("GET", `/hr/face/logs${status ? `?status=${status}` : ""}`),
  recent: (limit = 20) => req<FaceLog[]>("GET", `/hr/face/recent?limit=${limit}`),
  analytics: () => req<FaceAnalytics>("GET", "/hr/face/analytics"),
};
