const API = (import.meta.env.VITE_API_URL ?? "") as string;
const TOKEN_KEY = "zacodehr_token";
const EMPLOYEE_KEY = "zacodehr_employee";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMPLOYEE_KEY);
}
export function getStoredEmployee(): Employee | null {
  try {
    const raw = localStorage.getItem(EMPLOYEE_KEY);
    return raw ? JSON.parse(raw) as Employee : null;
  } catch { return null; }
}
export function setStoredEmployee(emp: Employee): void {
  localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(emp));
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = "حدث خطأ في الاتصال";
    try {
      const data = await r.json();
      msg = data?.error || data?.message || msg;
    } catch {
      try { msg = await r.text(); } catch {}
    }
    if (r.status === 401) {
      clearAuth();
      // App is served under a base path (/zacodehr/) — keep the redirect inside it.
      window.location.href = `${import.meta.env.BASE_URL ?? "/"}login`;
    }
    throw new Error(msg);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle<T>(r);
}

// ─── Types ──────────────────────────────────────────────────────────────

export type Employee = {
  id: number;
  code: string;
  nameAr: string;
  nameEn?: string;
  jobTitle: string;
  department: string;
  photoUrl?: string;
};

export type Company = {
  code: string;
  nameAr: string;
};

export type LoginResponse = {
  token: string;
  employee: Employee;
  company: Company;
};

export type MeResponse = {
  employee: Employee;
  company: Company;
  shift?: { start: string; end: string };
  work?: { lat: number; lng: number; radiusM: number } | null;
  today: {
    date: string;
    checkIn?: string;
    checkOut?: string;
    status: string;
  };
  month: {
    presentDays: number;
    absentDays: number;
    lateCount: number;
    pendingRequests: number;
  };
};

export type FaceStatus = {
  enrolled: boolean;
  required: boolean;
  requireLiveness: boolean;
  minQuality: number;
};

export type FacePayload = {
  descriptor: number[];
  qualityScore: number;
  livenessPassed: boolean;
  imageB64: string;
  imageMime: string;
};

export type PunchResponse = {
  ok: boolean;
  time: string;
  gpsStatus: "ok" | "out_of_range" | "no_gps";
};

export type AttendanceRow = {
  date: string;
  checkIn?: string;
  checkOut?: string;
  status: string;
  lateMinutes: number;
  workedHours: string;
};

export type MovementRow = {
  id: number;
  date: string;
  time: string;
  type: "in" | "out";
  location: string | null;
  selfieUrl: string | null;
  faceVerified: boolean | null;
};

export type PermissionRow = {
  id: number;
  permissionDate: string;
  startTime: string;
  endTime: string;
  minutes: number;
  permissionType: "personal" | "official";
  reason: string;
  status: "pending" | "approved" | "rejected";
};

export type LeaveRow = {
  id: number;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
};

export type PayslipRow = {
  id: number;
  year: number;
  month: number;
  grossSalary: string;
  totalDeductions: string;
  netSalary: string;
  status: string;
};

// ─── Endpoints ──────────────────────────────────────────────────────────

export const api = {
  login: (body: any) => req<LoginResponse>("POST", "/api/hr-portal/login", body),
  me: () => req<MeResponse>("GET", "/api/hr-portal/me"),
  punch: (body: { type: "in" | "out"; lat?: number; lng?: number; accuracy?: number } & Partial<FacePayload>) => 
    req<PunchResponse>("POST", "/api/hr-portal/punch", body),
  faceStatus: () => req<FaceStatus>("GET", "/api/hr-portal/face/status"),
  faceEnroll: (body: FacePayload) => req<{ ok: boolean }>("POST", "/api/hr-portal/face/enroll", body),
  getAttendance: (year: number, month: number) => 
    req<{ rows: AttendanceRow[] }>("GET", `/api/hr-portal/attendance?year=${year}&month=${month}`),
  getMovements: (year: number, month: number) =>
    req<{ rows: MovementRow[] }>("GET", `/api/hr-portal/movements?year=${year}&month=${month}`),
  getPermissions: () => 
    req<{ rows: PermissionRow[] }>("GET", "/api/hr-portal/permissions"),
  createPermission: (body: any) => 
    req<PermissionRow>("POST", "/api/hr-portal/permissions", body),
  getLeaves: () => 
    req<{ rows: LeaveRow[] }>("GET", "/api/hr-portal/leaves"),
  createLeave: (body: any) => 
    req<LeaveRow>("POST", "/api/hr-portal/leaves", body),
  getPayslips: () => 
    req<{ rows: PayslipRow[] }>("GET", "/api/hr-portal/payslips"),
};
