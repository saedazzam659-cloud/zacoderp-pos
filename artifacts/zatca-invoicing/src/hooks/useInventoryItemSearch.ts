import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJsonArray } from "@/lib/fetchJsonArray";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Loads only searched results and the items already present on the document.
 * The legacy full-catalog API remains available to reports that need every item.
 */
export function useInventoryItemSearch(
  companyId: number | undefined,
  headers: HeadersInit,
  selectedIds: Array<string | number | null | undefined>,
  enabled = true,
) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const selectedKey = useMemo(
    () => [...new Set(selectedIds.map(String).filter(id => /^\d+$/.test(id) && Number(id) > 0))]
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, 500)
      .join(","),
    [selectedIds],
  );
  const companyQuery = companyId ? `companyId=${companyId}&` : "";

  const selectedQuery = useQuery<any[]>({
    queryKey: ["inventory-items", companyId, "selected", selectedKey],
    queryFn: () => fetchJsonArray(
      `${API}/api/inventory/items/lookup?${companyQuery}ids=${encodeURIComponent(selectedKey)}`,
      headers,
    ),
    enabled: enabled && !!selectedKey,
    staleTime: 5 * 60 * 1000,
  });

  const searchQuery = useQuery<any[]>({
    queryKey: ["inventory-items", companyId, "search", debouncedSearch],
    queryFn: () => fetchJsonArray(
      `${API}/api/inventory/items/search?${companyQuery}includeHidden=1&q=${encodeURIComponent(debouncedSearch)}&limit=50`,
      headers,
    ),
    enabled,
    staleTime: 60 * 1000,
  });

  const items = useMemo(() => {
    const byId = new Map<string, any>();
    for (const item of selectedQuery.data ?? []) byId.set(String(item.id), item);
    for (const item of searchQuery.data ?? []) byId.set(String(item.id), item);
    return [...byId.values()];
  }, [selectedQuery.data, searchQuery.data]);

  return {
    items,
    search,
    setSearch,
    isSearching: searchQuery.isFetching || debouncedSearch !== search.trim(),
  };
}
