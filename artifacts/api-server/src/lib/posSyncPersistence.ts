import { salesInvoiceLinesTable, salesInvoicesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { assertInvoiceHasRealItemLine } from "./invoiceLineValidation.js";

type PosPayload = Record<string, any>;
type LineValidator = (
  companyId: number,
  lines: unknown,
  executor: any,
  documentName?: string,
) => Promise<number[]>;

/**
 * Persist one offline POS invoice as a single transaction.  In particular,
 * never create the header first and then attempt the lines on the root db:
 * a malformed line or a database error must roll the header back as well.
 */
export async function persistPosSyncInvoice(
  executor: any,
  companyId: number,
  clientId: string,
  payload: PosPayload,
  validateLines: LineValidator = assertInvoiceHasRealItemLine,
): Promise<{ id: number; duplicate?: boolean }> {
  return executor.transaction(async (tx: any) => {
    const existing = await tx.select({ id: salesInvoicesTable.id })
      .from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, companyId),
        sql`${salesInvoicesTable.notes} LIKE ${`%[offline:${clientId}]%`}`,
      ))
      .limit(1);
    if (existing.length) {
      return { id: existing[0].id, duplicate: true };
    }

    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    await validateLines(companyId, lines, tx, "فاتورة المبيعات");
    const noteTag = `[offline:${clientId}]`;
    const notes = payload.notes ? `${payload.notes} ${noteTag}` : noteTag;
    const [invoice] = await tx.insert(salesInvoicesTable).values({
      companyId,
      customerId: payload.customerId ?? null,
      branchId: payload.branchId ?? null,
      invoiceDate: payload.invoiceDate,
      paymentType: payload.paymentType ?? "cash",
      cashBoxId: payload.cashBoxId ?? null,
      bankAccountId: payload.bankAccountId ?? null,
      currencyCode: payload.currencyCode ?? "SAR",
      subtotal: String(payload.subtotal ?? 0),
      vatAmount: String(payload.vatAmount ?? 0),
      discountAmount: String(payload.discountAmount ?? 0),
      totalAmount: String(payload.totalAmount ?? 0),
      priceIncludesVat: !!payload.priceIncludesVat,
      status: "draft",
      notes,
    }).returning({ id: salesInvoicesTable.id });

    if (lines.length) {
      await tx.insert(salesInvoiceLinesTable).values(
        lines.map((line: any) => ({
          invoiceId: invoice.id,
          companyId,
          itemId: line.itemId ?? null,
          itemName: line.itemName,
          itemCode: line.itemCode ?? null,
          unit: line.unit ?? null,
          unitId: line.unitId ?? null,
          warehouseId: line.warehouseId ?? null,
          qty: String(line.qty),
          unitPrice: String(line.unitPrice),
          discount: String(line.discount ?? 0),
          vatRate: String(line.vatRate ?? 15),
          lineTotal: String(line.lineTotal),
        })),
      );
    }
    return { id: invoice.id };
  });
}
