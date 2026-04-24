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

  // Per Branch Filter Policy (replit.md): a user with viewAllBranches=false
  // must only ever see, in a branch dropdown, the branches they're linked to.
  // admin/superadmin always see every branch.
  const isPrivileged = user?.role === "admin" || user?.role === "superadmin";
  const restrictedIds: number[] | null =
    !isPrivileged && user?.viewAllBranches === false
      ? (user?.branchIds ?? [])
      : null;

  return useQuery<Branch[]>({
    queryKey: ["branches", cid, restrictedIds?.join(",") ?? "all"],
    enabled: !!token,
    queryFn: async () => {
      const url = `${API}/api/org/branches${cid ? `?companyId=${cid}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      const all = (await r.json()) as Branch[];
      if (restrictedIds === null) return all;
      const allowed = new Set(restrictedIds);
      return all.filter((b) => allowed.has(b.id));
    },
    staleTime: 5 * 60 * 1000,
  });
}
