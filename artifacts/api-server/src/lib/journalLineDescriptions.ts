function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function firstJournalDescription(...values: unknown[]): string {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

export function uniqueJournalNames(values: unknown[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function itemNamesDescription(
  itemNames: unknown[],
  fallback: string,
): string {
  const names = uniqueJournalNames(itemNames);
  return names.length ? `الصنف: ${names.join("، ")}` : fallback;
}

export function itemNamesWithSupplierDescription(
  itemNames: unknown[],
  supplierName: unknown,
  fallback: string,
): string {
  const items = itemNamesDescription(itemNames, "");
  const supplier = clean(supplierName);
  const parts = [
    items,
    supplier ? `المورد: ${supplier}` : "",
  ].filter(Boolean);
  return parts.join(" — ") || fallback;
}

export function namedPartyDescription(
  label: string,
  partyName: unknown,
  fallback: string,
): string {
  const name = clean(partyName);
  return name ? `${label}: ${name}` : fallback;
}