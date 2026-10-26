export const INVOICE_FIELDS = [
  "source_doc_number", "document_date", "source_datetime", "source_invoice_number", "party_code", "party_name",
  "branch_code", "item_code", "item_name", "unit_code", "unit_name", "warehouse_code", "qty", "free_qty", "unit_price",
  "discount_percent", "line_discount_amount", "vat_rate", "line_total", "subtotal", "vat_amount",
  "discount_amount", "total_amount", "payment_type", "currency_code", "exchange_rate",
  "cash_box_code", "bank_account_code", "price_includes_vat", "total_expenses_loaded", "line_notes",
] as const;

function parseJsonResponse(text: string): unknown {
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidate = fenced[1].trim();

  try {
    return JSON.parse(candidate);
  } catch {
    const firstObject = candidate.indexOf("{");
    const lastObject = candidate.lastIndexOf("}");
    if (firstObject < 0 || lastObject <= firstObject) return null;
    try {
      return JSON.parse(candidate.slice(firstObject, lastObject + 1));
    } catch {
      return null;
    }
  }
}

/** Normalize occasional fenced or wrapped model output into the import contract. */
export function parseInvoiceExtractionRows(text: string): Array<Record<(typeof INVOICE_FIELDS)[number], string>> {
  const parsed = parseJsonResponse(text);
  const rawRows = Array.isArray(parsed) ? parsed : (parsed as any)?.rows;
  if (!Array.isArray(rawRows)) return [];

  return rawRows
    .filter((row: unknown) => row && typeof row === "object" && !Array.isArray(row))
    .map((row: Record<string, unknown>) => Object.fromEntries(
      INVOICE_FIELDS.map((field) => [field, row[field] == null ? "" : String(row[field]).trim()]),
    ) as Record<(typeof INVOICE_FIELDS)[number], string>)
    .filter((row) => row.source_doc_number || row.item_code || row.item_name);
}
