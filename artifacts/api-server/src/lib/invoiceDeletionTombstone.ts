import { deletedRecordsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

function hasZatcaArtifacts(invoice: any): boolean {
  const status = String(invoice?.zatcaStatus ?? "").trim().toLowerCase();
  if (status && status !== "pending") return true;
  return [
    invoice?.zatcaSubmittedAt,
    invoice?.zatcaUuid,
    invoice?.xmlContent,
    invoice?.invoiceHash,
    invoice?.zatcaIcv,
    invoice?.zatcaPih,
    invoice?.zatcaResponseCode,
    invoice?.zatcaErrorMessages,
    invoice?.zatcaWarningMessages,
  ].some((value) => value !== null && value !== undefined && String(value).trim() !== "");
}

/**
 * Record a deleted invoice and remove it using the same transaction
 * connection.  The snapshot is intentionally a full row (not just the
 * number) while explicitly preserving the camelCase docNumber/status keys
 * consumed by sequence reclamation.
 */
export async function tombstoneAndDeleteDraftInvoice(
  tx: any,
  table: any,
  tableName: "sales_invoices" | "purchase_invoices",
  snapshot: any,
  meta: {
    companyId: number;
    recordId: number;
    deletedBy: number | null;
    deletedByUsername: string | null;
    reason: string;
  },
): Promise<void> {
  if (snapshot?.status !== "draft") {
    throw Object.assign(new Error("فقط الفاتورة المسودة قابلة للحذف"), { status: 409 });
  }
  if (hasZatcaArtifacts(snapshot)) {
    throw Object.assign(new Error("لا يمكن حذف فاتورة لها آثار ZATCA"), { status: 409 });
  }

  await tx.insert(deletedRecordsTable).values({
    tableName,
    companyId: meta.companyId,
    recordId: meta.recordId,
    payload: {
      ...snapshot,
      companyId: meta.companyId,
      docNumber: snapshot.docNumber ?? null,
      status: snapshot.status,
    },
    deletedBy: meta.deletedBy,
    deletedByUsername: meta.deletedByUsername,
    reason: meta.reason,
    source: "manual",
  });
  const removed = await tx.delete(table)
    .where(and(
      eq(table.id, meta.recordId),
      eq(table.companyId, meta.companyId),
      eq(table.status, "draft"),
    ))
    .returning({ id: table.id });
  if (!removed.length) {
    throw Object.assign(new Error("تعذر حذف الفاتورة بعد تسجيل سجل الحذف"), { status: 409 });
  }
}
