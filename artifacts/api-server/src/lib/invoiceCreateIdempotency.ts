import { sql } from "drizzle-orm";

export type InvoiceCreateKind = "sales_invoice" | "purchase_invoice";

const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

function invoiceColumn(invoiceKind: InvoiceCreateKind) {
  return invoiceKind === "sales_invoice"
    ? sql.raw("sales_invoice_id")
    : sql.raw("purchase_invoice_id");
}

/**
 * The key is deliberately opaque: clients currently send a UUID, but accepting
 * any non-empty bounded string makes this safe for older mobile clients which
 * may use another UUID representation.
 */
export function parseInvoiceClientRequestId(body: unknown): string | null {
  const value = (body as { clientRequestId?: unknown } | null | undefined)?.clientRequestId;
  if (value == null) return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error("معرّف طلب إنشاء الفاتورة يجب أن يكون نصاً"), { status: 400 });
  }
  const key = value.trim();
  if (!key || key.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
    throw Object.assign(new Error(`معرّف طلب إنشاء الفاتورة يجب أن يكون بين 1 و${MAX_CLIENT_REQUEST_ID_LENGTH} حرفاً`), { status: 400 });
  }
  return key;
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

export async function findInvoiceCreateReplay(
  executor: any,
  companyId: number,
  invoiceKind: InvoiceCreateKind,
  clientRequestId: string,
): Promise<number | null> {
  const column = invoiceColumn(invoiceKind);
  const rows = resultRows(await executor.execute(sql`
    SELECT ${column} AS invoice_id
      FROM invoice_create_idempotency
     WHERE company_id = ${companyId}
       AND invoice_kind = ${invoiceKind}
       AND client_request_id = ${clientRequestId}
     LIMIT 1
  `));
  const invoiceId = Number(rows[0]?.invoice_id);
  return Number.isInteger(invoiceId) && invoiceId > 0 ? invoiceId : null;
}

/** Remove a claim only when its just-created draft is being compensated away. */
export async function deleteInvoiceCreateReplay(
  executor: any,
  companyId: number,
  invoiceKind: InvoiceCreateKind,
  clientRequestId: string,
): Promise<void> {
  await executor.execute(sql`
    DELETE FROM invoice_create_idempotency
     WHERE company_id = ${companyId}
       AND invoice_kind = ${invoiceKind}
       AND client_request_id = ${clientRequestId}
  `);
}

/**
 * Claims the request key and writes the invoice in the same database
 * transaction. The unique index makes concurrent API workers wait for the
 * first transaction; the loser then reads its committed invoice id.
 */
export async function createInvoiceIdempotently<T>(
  executor: any,
  options: {
    companyId: number;
    invoiceKind: InvoiceCreateKind;
    clientRequestId: string;
    create: (tx: any) => Promise<T & { id: number }>;
  },
): Promise<{ created: true; invoice: T } | { created: false; invoiceId: number }> {
  return executor.transaction(async (tx: any) => {
    const claimed = resultRows(await tx.execute(sql`
      INSERT INTO invoice_create_idempotency
        (company_id, invoice_kind, client_request_id)
      VALUES
        (${options.companyId}, ${options.invoiceKind}, ${options.clientRequestId})
      ON CONFLICT (company_id, invoice_kind, client_request_id) DO NOTHING
      RETURNING id
    `));

    if (!claimed.length) {
      const invoiceId = await findInvoiceCreateReplay(
        tx, options.companyId, options.invoiceKind, options.clientRequestId,
      );
      if (!invoiceId) {
        // A committed row cannot be incomplete: claim and invoice are atomic.
        throw Object.assign(new Error("تعذر استعادة نتيجة طلب إنشاء الفاتورة"), { status: 409 });
      }
      return { created: false as const, invoiceId };
    }

    const invoice = await options.create(tx);
    const column = invoiceColumn(options.invoiceKind);
    await tx.execute(sql`
      UPDATE invoice_create_idempotency
         SET ${column} = ${invoice.id}
       WHERE company_id = ${options.companyId}
         AND invoice_kind = ${options.invoiceKind}
         AND client_request_id = ${options.clientRequestId}
    `);
    return { created: true as const, invoice };
  });
}