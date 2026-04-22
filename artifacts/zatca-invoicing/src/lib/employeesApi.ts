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
};
