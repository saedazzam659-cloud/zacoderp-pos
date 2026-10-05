export type InvoiceDateFields = {
  issueDate: string;
  supplyDate: string | null;
  dueDate: string | null;
};

function parseDateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

export function parseInvoiceDateFields(value: unknown): InvoiceDateFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const issueDate = parseDateOnly(body.issueDate);
  if (!issueDate) return null;

  const supplyDate = body.supplyDate === undefined ? null : parseDateOnly(body.supplyDate);
  const dueDate = body.dueDate === undefined ? null : parseDateOnly(body.dueDate);
  if ((body.supplyDate !== undefined && !supplyDate) || (body.dueDate !== undefined && !dueDate)) {
    return null;
  }

  return { issueDate, supplyDate, dueDate };
}
