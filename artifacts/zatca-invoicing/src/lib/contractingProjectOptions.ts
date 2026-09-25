export type ContractingProjectOptions = {
  branches: { id: number; code: string; nameAr: string; nameEn: string | null }[];
  projects: { id: number; code: string; nameAr: string; nameEn: string | null; parentId: number | null; branchId: number | null }[];
  integrityDiagnostics?: { deferredValidation: boolean; offendingIds: Record<string, number[]> };
};

const API = import.meta.env.VITE_API_URL || "";

// This endpoint also computes tenant-wide integrity diagnostics. Share the
// in-flight request across list/detail, but never across auth sessions/scopes.
export const contractingOptionsKey = (userId: number | undefined, companyId: number | undefined, actingCompanyId: number | undefined, token: string | undefined) =>
  ["contracting-project-options", userId, companyId, actingCompanyId, token] as const;

export async function fetchContractingProjectOptions(token: string, actingCompanyId?: number): Promise<ContractingProjectOptions> {
  const response = await fetch(`${API}/api/contracting/projects/options`, {
    headers: { Authorization: `Bearer ${token}`, ...(actingCompanyId ? { "x-acting-company-id": String(actingCompanyId) } : {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  if (!Array.isArray(payload?.branches) || !Array.isArray(payload?.projects)) {
    throw new Error("استجابة خيارات المشاريع غير صالحة");
  }
  return payload;
}