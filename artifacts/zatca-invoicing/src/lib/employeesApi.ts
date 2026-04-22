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

export const employeesApi = {
  list:    () => req<any[]>("GET", "/employees"),
  get:     (id: number) => req<any>("GET", `/employees/${id}`),
  alerts:  () => req<any>("GET", "/employees/alerts"),
  create:  (data: any) => req<any>("POST", "/employees", data),
  update:  (id: number, data: any) => req<any>("PUT", `/employees/${id}`, data),
  remove:  (id: number) => req<any>("DELETE", `/employees/${id}`),

  contracts: (empId: number) => req<any[]>("GET", `/employees/${empId}/contracts`),
  addContract: (empId: number, data: any) => req<any>("POST", `/employees/${empId}/contracts`, data),
  renewContract: (empId: number, contractId: number, data: any) =>
    req<any>("POST", `/employees/${empId}/contracts/${contractId}/renew`, data),
  updateContract: (empId: number, contractId: number, data: any) =>
    req<any>("PUT", `/employees/${empId}/contracts/${contractId}`, data),
  deleteContract: (empId: number, contractId: number) =>
    req<any>("DELETE", `/employees/${empId}/contracts/${contractId}`),

  leaves: (empId: number) => req<any[]>("GET", `/employees/${empId}/leaves`),
  addLeave: (empId: number, data: any) => req<any>("POST", `/employees/${empId}/leaves`, data),
  updateLeave: (empId: number, leaveId: number, data: any) =>
    req<any>("PUT", `/employees/${empId}/leaves/${leaveId}`, data),
  deleteLeave: (empId: number, leaveId: number) =>
    req<any>("DELETE", `/employees/${empId}/leaves/${leaveId}`),

  aiParseId: (text: string) => req<any>("POST", "/ai/parse-employee-id", { text }),
  aiSuggestContract: (input: any) => req<any>("POST", "/ai/suggest-contract-terms", input),
  aiSuggestLeavePolicy: (input: any) => req<any>("POST", "/ai/suggest-leave-policy", input),

  // Attendance
  attendance: (params: { date?: string; employeeId?: number; from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params.date) qs.set("date", params.date);
    if (params.employeeId) qs.set("employeeId", String(params.employeeId));
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString(); return req<any[]>("GET", `/employees/attendance/list${q ? `?${q}` : ""}`);
  },
  addAttendance:    (data: any) => req<any>("POST", "/employees/attendance", data),
  updateAttendance: (id: number, data: any) => req<any>("PUT", `/employees/attendance/${id}`, data),
  deleteAttendance: (id: number) => req<any>("DELETE", `/employees/attendance/${id}`),
  bulkAttendance:   (date: string, records: any[]) => req<any>("POST", "/employees/attendance/bulk", { date, records }),

  // Loans
  loans:        (params: { employeeId?: number; status?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.employeeId) qs.set("employeeId", String(params.employeeId));
    if (params.status) qs.set("status", params.status);
    const q = qs.toString(); return req<any[]>("GET", `/employees/loans/list${q ? `?${q}` : ""}`);
  },
  addLoan:    (data: any) => req<any>("POST", "/employees/loans", data),
  updateLoan: (id: number, data: any) => req<any>("PUT", `/employees/loans/${id}`, data),
  deleteLoan: (id: number) => req<any>("DELETE", `/employees/loans/${id}`),

  // EOS
  endOfService: (empId: number, reason: "resignation" | "termination" = "resignation") =>
    req<any>("GET", `/employees/${empId}/end-of-service?reason=${reason}`),
  aiExplainEos: (calc: any, employee: any) => req<any>("POST", "/ai/explain-eos", { calc, employee }),
  aiParseAttendance: (data: { text: string; employees: any[]; date: string; defaultCheckIn?: string; defaultCheckOut?: string }) =>
    req<any>("POST", "/ai/parse-attendance", data),
  aiExplainPayrollLine: (line: any, periodMonth?: string) =>
    req<any>("POST", "/ai/explain-payroll-line", { line, periodMonth }),

  // All contracts (cross-employee)
  allContracts: (filters: { status?: string; expiringDays?: number } = {}) => {
    const qs = new URLSearchParams();
    if (filters.status) qs.set("status", filters.status);
    if (filters.expiringDays) qs.set("expiringDays", String(filters.expiringDays));
    const q = qs.toString(); return req<any[]>("GET", `/employees/contracts/all${q ? `?${q}` : ""}`);
  },

  // Payroll
  payrollRuns:    () => req<any[]>("GET", "/employees/payroll/runs"),
  payrollRun:     (id: number) => req<any>("GET", `/employees/payroll/runs/${id}`),
  payrollPreview: (year: number, month: number) => req<any>("POST", "/employees/payroll/preview", { year, month }),
  createPayroll:  (data: any) => req<any>("POST", "/employees/payroll/runs", data),
  postPayroll:    (id: number) => req<any>("POST", `/employees/payroll/runs/${id}/post`, {}),
  deletePayroll:  (id: number) => req<any>("DELETE", `/employees/payroll/runs/${id}`),
};
