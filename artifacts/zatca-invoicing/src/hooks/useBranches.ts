import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

export type Branch = {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string | null;
  regionId?: number | null;
  isActive?: boolean;
};

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export function useBranches() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : (user?.company?.id ?? user?.companyId);

  return useQuery<Branch[]>({
    queryKey: ["branches", cid],
    enabled: !!token,
    queryFn: async () => {
      const url = `${API}/api/org/branches${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}
