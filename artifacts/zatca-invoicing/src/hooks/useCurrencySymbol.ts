import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { currencySymbol } from "@/lib/format";

const API = import.meta.env.VITE_API_URL ?? "";

export interface CurrencyRow {
  code: string;
  symbol?: string | null;
  isDefault?: boolean;
}

/**
 * Loads the acting company's currency rows (cached, deduped with the
 * ["currencies", cid] query used by the document forms).
 */
export function useCompanyCurrencies() {
  const { user, token } = useAuth() as any;
  const cid = user?.role === "superadmin" ? undefined : user?.company?.id;
  return useQuery<CurrencyRow[]>({
    queryKey: ["currencies", cid],
    queryFn: async () => {
      const r = await fetch(
        cid ? `${API}/api/currencies?companyId=${cid}` : `${API}/api/currencies`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      return r.ok ? r.json() : [];
    },
    staleTime: 5 * 60_000,
  });
}

/** Returns a resolver that maps any currency code → its display symbol. */
export function useResolveCurrencySymbol(): (code?: string | null) => string {
  const { data: currencies = [] } = useCompanyCurrencies();
  return (code?: string | null) => currencySymbol(code, currencies);
}

/** Returns the symbol of the company's base (default) currency. */
export function useBaseCurrencySymbol(): string {
  const { data: currencies = [] } = useCompanyCurrencies();
  const def = currencies.find(c => c.isDefault) ?? currencies[0];
  return currencySymbol(def?.code, currencies);
}
