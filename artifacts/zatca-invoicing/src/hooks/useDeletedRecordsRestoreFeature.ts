import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
export const DELETED_RECORDS_RESTORE_QUERY_KEY = ["superadmin-feature", "deleted-records-restore"] as const;

export type DeletedRecordsRestoreFeature = { enabled: boolean; updatedAt?: string | null };

export function useDeletedRecordsRestoreFeature() {
  const { token, user } = useAuth();
  return useQuery<DeletedRecordsRestoreFeature>({
    queryKey: DELETED_RECORDS_RESTORE_QUERY_KEY,
    enabled: user?.role === "superadmin" && !!token,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`${API}/api/admin/system-settings/deleted-records-restore`, {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error ?? "تعذر تحميل إعداد استعادة المحذوفات");
      return data as DeletedRecordsRestoreFeature;
    },
  });
}