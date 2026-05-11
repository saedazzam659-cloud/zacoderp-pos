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
export function useCostCenters() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : (user?.company?.id ?? user?.companyId);

  return useQuery<CostCenter[]>({
    queryKey: ["cost-centers", cid],
    enabled: !!token,
    queryFn: async () => {
      const url = `${API}/api/cost-centers${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      const all = (await r.json()) as CostCenter[];
      return all.filter(c => c.isActive !== false);
    },
    staleTime: 5 * 60 * 1000,
  });
}
