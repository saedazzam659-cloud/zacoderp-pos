export function normalizeInvoiceLineVatRate(value: unknown, fallbackRate = "15"): string {
  return value == null || String(value).trim() === ""
    ? fallbackRate
    : String(value);
}
