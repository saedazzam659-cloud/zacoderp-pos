/**
 * Loads the company chart of accounts once and exposes the derived
 * hierarchy tree (see `lib/accountTree`). Shared by the General Accounts
 * reports + the AccountParentFilter so the COA is fetched a single time
 * (React Query dedups identical query keys).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { buildAccountTree, type AccountNode } from "@/lib/accountTree";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export function useAccountTree() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  const headers = { Authorization: `Bearer ${token}` };

  const { data: accounts = [], isLoading } = useQuery<AccountNode[]>({
    queryKey: ["accounts", cid],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cid) params.set("companyId", String(cid));
      const res = await fetch(`${API}/api/accounts?${params}`, { headers });
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const tree = useMemo(() => buildAccountTree(accounts), [accounts]);
  return { accounts, tree, isLoading };
}
