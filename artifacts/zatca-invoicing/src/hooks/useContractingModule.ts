import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { companyExplicitlyEnablesModule } from "@/lib/companyModuleGate";

const API = import.meta.env.VITE_API_URL || "";

/**
 * Optional project attribution is available only when the effective company
 * explicitly enables Contracting. SuperAdmins use the company they are acting
 * as; without an acting company the feature stays hidden.
 */
export function useContractingModule() {
  const { user, token, actingCompanyId } = useAuth();
  const isSuperAdmin = user?.role === "superadmin";
  const { data: actingCompany } = useQuery<{ menuPermissions?: string | null }>({
    queryKey: ["company-contracting-module", actingCompanyId],
    enabled: !!isSuperAdmin && !!actingCompanyId && !!token,
    queryFn: async () => {
      const response = await fetch(`${API}/api/companies/${actingCompanyId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-acting-company-id": String(actingCompanyId),
        },
      });
      if (!response.ok) throw new Error(`تعذر تحميل إعداد المقاولات: HTTP ${response.status}`);
      return response.json();
    },
  });

  return {
    enabled: isSuperAdmin
      ? !!actingCompany && companyExplicitlyEnablesModule({ company: actingCompany }, "contracting")
      : !!user && companyExplicitlyEnablesModule(user, "contracting"),
    actingCompanyId: isSuperAdmin ? actingCompanyId : null,
  };
}
