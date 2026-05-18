import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

export type Region = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  notes: string | null;
  branchCount?: number;
};

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Loads the per-company list of geographic regions (المناطق) used by the
 * canonical `<RegionFilter />` component. Mirrors `useBranches` in scope
 * and caching strategy.
 */
export function useRegions() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : (user?.company?.id ?? user?.companyId);

  return useQuery<Region[]>({
    queryKey: ["regions", cid],
    enabled: !!token,
    queryFn: async () => {
      const url = `${API}/api/org/regions${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}
