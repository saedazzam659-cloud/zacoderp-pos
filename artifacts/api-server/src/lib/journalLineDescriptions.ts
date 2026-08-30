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

export function journalDisplayDate(value: unknown): string {
  const date = clean(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : date;
}

export function purchaseSupplierDescription(input: {
  supplierName: unknown;
  purchaseInvoiceNumber: unknown;
  supplierInvoiceNumber: unknown;
  supplierInvoiceDate: unknown;
  fallback: string;
}): string {
  const supplier = clean(input.supplierName);
  const purchaseInvoiceNumber = clean(input.purchaseInvoiceNumber);
  const supplierInvoiceNumber = clean(input.supplierInvoiceNumber);
  const supplierInvoiceDate = journalDisplayDate(input.supplierInvoiceDate);
  const parts = [
    supplier ? `المورد: ${supplier}` : "",
    purchaseInvoiceNumber ? `فاتورة المشتريات: ${purchaseInvoiceNumber}` : "",
    supplierInvoiceNumber ? `فاتورة المورد: ${supplierInvoiceNumber}` : "",
    supplierInvoiceDate ? `تاريخ فاتورة المورد: ${supplierInvoiceDate}` : "",
  ].filter(Boolean);
  return parts.join(" — ") || input.fallback;
}