import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJsonArray } from "@/lib/fetchJsonArray";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function findInventoryItemByCode(
  rawCode: string,
  companyId: number | undefined,
  headers: HeadersInit,
): Promise<any | null> {
  const code = rawCode.trim();
  if (!code) return null;

  const params = new URLSearchParams({
    includeHidden: "1",
    q: code,
    limit: "50",
  });
  if (companyId) params.set("companyId", String(companyId));

  const candidates = await fetchJsonArray(
    `${API}/api/inventory/items/search?${params}`,
    headers,
  );
  const exactItems = [...new Map(candidates
    .filter((item: any) => String(item.code ?? "").trim().toLowerCase() === code.toLowerCase())
    .map((item: any) => [String(item.id), item])).values()];
  return exactItems.length === 1 ? exactItems[0] : null;
}

/**
 * Loads only searched results and the items already present on the document.
 * The legacy full-catalog API remains available to reports that need every item.
 */
export function useInventoryItemSearch(
  companyId: number | undefined,
  headers: HeadersInit,
  selectedIds: Array<string | number | null | undefined>,
  enabled = true,
  itemNatures: string[] = [],
  natureOptions: { includeUnclassified?: boolean; onlyWhenEmpty?: boolean } = {},
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
  const applyNatureFilter = itemNatures.length > 0 &&
    (!natureOptions.onlyWhenEmpty || !debouncedSearch);
  const itemNatureQuery = applyNatureFilter
    ? `&itemNatures=${encodeURIComponent([...itemNatures].sort().join(","))}${natureOptions.includeUnclassified ? "&includeUnclassified=1" : ""}`
    : "";
  const natureFilterKey = applyNatureFilter ? [...itemNatures].sort().join(",") : "";

  const selectedQuery = useQuery<any[]>({
    queryKey: ["inventory-items", companyId, "selected", selectedKey],
    queryFn: () => fetchJsonArray(
      `${API}/api/inventory/items/lookup?${companyQuery}ids=${encodeURIComponent(selectedKey)}`,
      headers,
    ),
    enabled: enabled && !!selectedKey,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: "always",
  });

  const searchQuery = useQuery<any[]>({
    queryKey: ["inventory-items", companyId, "search", debouncedSearch, natureFilterKey, Boolean(natureOptions.includeUnclassified && applyNatureFilter)],
    queryFn: () => fetchJsonArray(
      `${API}/api/inventory/items/search?${companyQuery}includeHidden=1&q=${encodeURIComponent(debouncedSearch)}&limit=50${itemNatureQuery}`,
      headers,
    ),
    enabled,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: "always",
  });

  // Keep the last known row for a selected item while its dedicated lookup is
  // in flight. Otherwise clearing/changing the search can temporarily remove
  // the selected label from the controlled combobox.
  const knownItemsRef = useRef(new Map<string, any>());
  useEffect(() => {
    for (const item of [...(selectedQuery.data ?? []), ...(searchQuery.data ?? [])]) {
      knownItemsRef.current.set(String(item.id), item);
    }
  }, [selectedQuery.data, searchQuery.data]);

  const items = useMemo(() => {
    const byId = new Map<string, any>();
    for (const item of selectedQuery.data ?? []) byId.set(String(item.id), item);
    for (const item of searchQuery.data ?? []) byId.set(String(item.id), item);
    for (const id of selectedKey.split(",").filter(Boolean)) {
      const known = knownItemsRef.current.get(id);
      if (known && !byId.has(id)) byId.set(id, known);
    }
    return [...byId.values()];
  }, [selectedQuery.data, searchQuery.data, selectedKey]);

  return {
    items,
    search,
    setSearch,
    // Background refetches (for example when a second line opens an old search
    // after the cache becomes stale) must not replace already available choices
    // with the loading state. Only show the blocking search state before the
    // first result for this query arrives, or during the short debounce window.
    isSearching: searchQuery.isLoading || debouncedSearch !== search.trim(),
  };
}
