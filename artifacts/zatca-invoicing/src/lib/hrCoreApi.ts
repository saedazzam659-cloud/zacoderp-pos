// HR Core extension API — ملف الموظف الشامل (تعديلات الراتب، النقل والتكليف،
// التقييمات، الطوارئ، الأسرة، المؤهلات، الشهادات، المستندات، السجل الوظيفي،
// نهاية الخدمة، الهيكل التنظيمي). Mirrors api-server routes/hr-core.ts.
const API = import.meta.env.VITE_API_URL ?? "";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("zatca_token");
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/hr-core${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? (undefined as any) : r.json();
}

export type HrSubResource =
  | "emergency-contacts" | "dependents" | "qualifications"
  | "certificates" | "documents" | "evaluations";

export const hrCoreApi = {
  // الهيكل التنظيمي
  departments:    () => req<any[]>("GET", "/departments"),
  addDepartment:  (d: any) => req<any>("POST", "/departments", d),
  updateDepartment: (id: number, d: any) => req<any>("PUT", `/departments/${id}`, d),
  positions:      () => req<any[]>("GET", "/positions"),
  addPosition:    (d: any) => req<any>("POST", "/positions", d),
  updatePosition: (id: number, d: any) => req<any>("PUT", `/positions/${id}`, d),

  // sub-resources الموحدة
  sub:    (empId: number, key: HrSubResource) => req<any[]>("GET", `/employees/${empId}/${key}`),
  addSub: (empId: number, key: HrSubResource, d: any) => req<any>("POST", `/employees/${empId}/${key}`, d),
  updateSub: (empId: number, key: HrSubResource, id: number, d: any) => req<any>("PUT", `/employees/${empId}/${key}/${id}`, d),
  deleteSub: (empId: number, key: HrSubResource, id: number) => req<any>("DELETE", `/employees/${empId}/${key}/${id}`),

  // تعديلات الرواتب
  salaryAdjustments:  (empId: number) => req<any[]>("GET", `/employees/${empId}/salary-adjustments`),
  addSalaryAdjustment:(empId: number, d: any) => req<any>("POST", `/employees/${empId}/salary-adjustments`, d),
  applySalaryAdjustment: (empId: number, id: number) => req<any>("POST", `/employees/${empId}/salary-adjustments/${id}/apply`),

  // النقل والتكليف
  transfers:    (empId: number) => req<any[]>("GET", `/employees/${empId}/transfers`),
  allTransfers: () => req<any[]>("GET", "/transfers"),
  addTransfer:  (empId: number, d: any) => req<any>("POST", `/employees/${empId}/transfers`, d),
  updateTransfer:(empId: number, id: number, d: any) => req<any>("PUT", `/employees/${empId}/transfers/${id}`, d),
  applyTransfer:(empId: number, id: number) => req<any>("POST", `/employees/${empId}/transfers/${id}/apply`),
  endTransfer:  (empId: number, id: number, effectiveTo?: string) => req<any>("POST", `/employees/${empId}/transfers/${id}/end`, { effectiveTo }),

  // السجل الوظيفي + نهاية الخدمة
  history:      (empId: number) => req<any[]>("GET", `/employees/${empId}/history`),
  terminations: (empId: number) => req<any[]>("GET", `/employees/${empId}/termination`),
  addTermination: (empId: number, d: any) => req<any>("POST", `/employees/${empId}/termination`, d),
  updateTermination: (empId: number, id: number, d: any) => req<any>("PUT", `/employees/${empId}/termination/${id}`, d),
  cancelTermination: (empId: number, id: number) => req<any>("POST", `/employees/${empId}/termination/${id}/cancel`),
};
