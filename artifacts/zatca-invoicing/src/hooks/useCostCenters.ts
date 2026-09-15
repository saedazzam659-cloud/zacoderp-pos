import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

export type CostCenter = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId?: number | null;
  level?: number | null;
  isPosting?: boolean;
  isActive?: boolean;
};

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Lists all cost centers for the current company. Mirrors the shape of
 * `useBranches` so the matching `CostCenterFilter` UI can plug into any
 * report's filter bar with the same ergonomics. No branch-style scoping
 * here — cost centers are not subject to per-user visibility caps yet.
 */
export function useCostCenters(options?: {
  /** Include inactive rows so an existing historical link can be displayed. */
  includeInactive?: boolean;
  /** Explicit tenant (needed when a super-admin is acting as a company). */
  companyId?: number | null;
}) {
  const { user, token, actingCompanyId } = useAuth() as any;
  const cid = options?.companyId
    ?? (user?.role === "superadmin" ? actingCompanyId ?? undefined : (user?.company?.id ?? user?.companyId));
  const includeInactive = options?.includeInactive === true;

  return useQuery<CostCenter[]>({
    queryKey: ["cost-centers", cid, includeInactive],
    enabled: !!token,
    queryFn: async () => {
      const url = `${API}/api/cost-centers${cid ? `?companyId=${cid}` : ""}`;
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (actingCompanyId) headers["x-acting-company-id"] = String(actingCompanyId);
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(await r.text());
      const all = (await r.json()) as CostCenter[];
      return includeInactive ? all : all.filter(c => c.isActive !== false);
    },
    staleTime: 5 * 60 * 1000,
  });
}
