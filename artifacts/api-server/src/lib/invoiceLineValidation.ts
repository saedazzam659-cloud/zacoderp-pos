import { db, itemsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

export type InvoiceLineInput = Record<string, unknown> | null | undefined;

export class InvoiceLineValidationError extends Error {
  readonly status = 400;
  readonly code: "REAL_ITEM_REQUIRED" | "ITEM_NOT_FOUND";

  constructor(
    code: "REAL_ITEM_REQUIRED" | "ITEM_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "InvoiceLineValidationError";
    this.code = code;
  }
}

/**
 * Empty grid rows are allowed in the browser and are normally filtered out by
 * the invoice forms. Treat the common default values (qty=1, price=0) as an
 * untouched filler row as well, so direct clients cannot bypass the real-line
 * requirement by sending the initial row back to the API.
 */
export function isInvoiceLineMeaningful(line: InvoiceLineInput): boolean {
  if (!line || typeof line !== "object") return true;
  const value = (key: string): unknown => line[key];
  const text = (key: string): string => String(value(key) ?? "").trim();
  const number = (key: string): number => Number(value(key));

  // A selected item always makes a row meaningful (including service items).
  if (value("itemId") !== null && value("itemId") !== undefined && text("itemId")) return true;
  if (["itemName", "name", "itemCode", "unit", "unitId", "warehouseId", "notes",
    "batchNumber", "expiryDate", "costCenter", "accountId"].some((key) => text(key))) {
    return true;
  }

  // New rows use qty=1 and unitPrice=0.  Only non-default numeric input is
  // considered an intentionally populated row.
  const qty = number("qty");
  const freeQty = number("freeQty");
  const weight = number("weight");
  const price = number("unitPrice");
  const discount = number("discount");
  const discountAmount = number("discountAmount");
  const lineTotal = number("lineTotal");
  return (Number.isFinite(qty) && qty > 0 && qty !== 1)
    || (Number.isFinite(freeQty) && freeQty > 0)
    || (Number.isFinite(weight) && weight > 0)
    || (Number.isFinite(price) && price > 0)
    || (Number.isFinite(discount) && discount > 0)
    || (Number.isFinite(discountAmount) && discountAmount > 0)
    || (Number.isFinite(lineTotal) && lineTotal > 0);
}

/**
 * Server-authoritative invoice line gate.  A real line is one whose itemId is
 * an existing item owned by the invoice's tenant.  Display-only descriptions
 * and untouched filler rows never count.  The item type/nature is intentionally
 * not inspected: service items are legitimate invoice items too.
 *
 * `executor` is injectable so conversion paths can use their transaction
 * connection and focused tests can exercise the validator without writes.
 */
export async function assertInvoiceHasRealItemLine(
  companyId: number,
  lines: InvoiceLineInput[] | unknown,
  executor: any = db,
  documentName = "الفاتورة",
): Promise<number[]> {
  const rows = Array.isArray(lines) ? lines : [];
  const attemptedIds: number[] = [];
  const itemlessMeaningfulRows: number[] = [];

  rows.forEach((line, index) => {
    const rawItemId = line && typeof line === "object" ? line.itemId : undefined;
    const hasItemValue = rawItemId !== null
      && rawItemId !== undefined
      && String(rawItemId).trim() !== "";
    const itemId = Number(rawItemId);
    if (hasItemValue) {
      if (Number.isInteger(itemId) && itemId > 0) attemptedIds.push(itemId);
      else itemlessMeaningfulRows.push(index);
    } else if (isInvoiceLineMeaningful(line)) {
      itemlessMeaningfulRows.push(index);
    }
  });

  const ids = [...new Set(attemptedIds)];
  if (itemlessMeaningfulRows.length) {
    throw new InvoiceLineValidationError(
      "REAL_ITEM_REQUIRED",
      `لا يمكن حفظ ${documentName}: يجب اختيار صنف حقيقي من قائمة الأصناف في كل سطر مستخدم؛ الوصف وحده لا يُحتسب كصنف`,
    );
  }

  const owned = ids.length
    ? await executor.select({ id: itemsTable.id })
      .from(itemsTable)
      .where(and(
        eq(itemsTable.companyId, companyId),
        inArray(itemsTable.id, ids),
      ))
    : [];
  const ownedIds = new Set(owned.map((row: { id: number }) => Number(row.id)));
  const invalidIds = ids.filter((id) => !ownedIds.has(id));
  if (invalidIds.length) {
    throw new InvoiceLineValidationError(
      "ITEM_NOT_FOUND",
      `لا يمكن حفظ ${documentName}: الصنف لا يخص الشركة الحالية أو غير موجود (${invalidIds.join(", ")})`,
    );
  }
  if (!ids.length) {
    throw new InvoiceLineValidationError(
      "REAL_ITEM_REQUIRED",
      `لا يمكن حفظ ${documentName}: أضف صنفًا واحدًا على الأقل`,
    );
  }
  return ids;
}
