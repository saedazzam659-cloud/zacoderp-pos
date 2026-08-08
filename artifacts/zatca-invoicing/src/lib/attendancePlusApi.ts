// API client for the developed Attendance & Time Management module
// (شاشة الحضور والانصراف المطوّرة) — /api/attendance-plus/*
const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}/api${path}`, { headers: authHeaders(), ...init, ...(init?.body ? {} : {}) });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? (undefined as any) : r.json();
}

export const attendancePlusApi = {
  // Shifts (الورديات)
  shifts: () => api("/attendance-plus/shifts"),
  addShift: (body: any) => api("/attendance-plus/shifts", { method: "POST", body: JSON.stringify(body) }),
  updateShift: (id: number, body: any) => api(`/attendance-plus/shifts/${id}`, { method: "PUT", body: JSON.stringify(body) }),

  // Movements (السجل اليومي للحركات)
  movements: (q: { date?: string; employeeId?: number; from?: string; to?: string }) =>
    api(`/attendance-plus/movements?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]))}`),
  addMovements: (items: any[]) => api("/attendance-plus/movements", { method: "POST", body: JSON.stringify({ items }) }),
  deleteMovement: (id: number, reason: string) =>
    api(`/attendance-plus/movements/${id}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" }),

  // Exit permissions (استئذان الخروج)
  permissions: (q: Record<string, any>) =>
    api(`/attendance-plus/permissions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]))}`),
  permissionBalance: (employeeId: number, month: string) =>
    api(`/attendance-plus/permissions/balance?employeeId=${employeeId}&month=${month}`),
  addPermission: (body: any) => api("/attendance-plus/permissions", { method: "POST", body: JSON.stringify(body) }),
  decidePermission: (id: number, decision: "approve" | "reject" | "cancel", note?: string) =>
    api(`/attendance-plus/permissions/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, note }) }),

  // Day board / recalc / monthly / violations
  day: (date: string) => api(`/attendance-plus/day?date=${date}`),
  recalc: (date: string) => api("/attendance-plus/recalc", { method: "POST", body: JSON.stringify({ date }) }),
  monthly: (month: string, employeeId?: number) =>
    api(`/attendance-plus/monthly?month=${month}${employeeId ? `&employeeId=${employeeId}` : ""}`),
  violations: (from: string, to: string) => api(`/attendance-plus/violations?from=${from}&to=${to}`),

  // Approval / lock / payroll transfer
  dayLocks: (from: string, to: string) => api(`/attendance-plus/day-locks?from=${from}&to=${to}`),
  setDayLock: (date: string, status: "approved" | "locked", notes?: string) =>
    api("/attendance-plus/day-locks", { method: "POST", body: JSON.stringify({ date, status, notes }) }),
  reopenDay: (date: string, reason?: string) =>
    api("/attendance-plus/day-locks/reopen", { method: "POST", body: JSON.stringify({ date, reason }) }),
  transfers: () => api("/attendance-plus/transfers"),
  transferPeriod: (period: string) => api("/attendance-plus/transfers", { method: "POST", body: JSON.stringify({ period }) }),

  audit: () => api("/attendance-plus/audit"),
};
