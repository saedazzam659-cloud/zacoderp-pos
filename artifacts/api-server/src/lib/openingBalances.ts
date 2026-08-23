import { db } from "@workspace/db";
import { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export const INVENTORY_OPENING_DEBIT_MARKER = "[opening-inventory:debit]";
export const INVENTORY_OPENING_CREDIT_MARKER = "[opening-inventory:credit]";

export function isManagedInventoryOpeningLine(line: { description?: string | null }): boolean {
  const value = String(line.description ?? "");
  return value.includes(INVENTORY_OPENING_DEBIT_MARKER)
    || value.includes(INVENTORY_OPENING_CREDIT_MARKER);
}

export async function findUnbalancedOpeningDrafts(
  companyId: number,
  range?: { startDate?: string; endDate?: string },
): Promise<Array<{ id: number; docNumber: string | null; entryDate: string; debit: string; credit: string }>> {
  const predicates: any[] = [
    eq(journalEntriesTable.companyId, companyId),
    eq(journalEntriesTable.entryType, "opening"),
    eq(journalEntriesTable.status, "draft"),
    sql`COALESCE(${journalEntriesTable.description}, '') NOT LIKE '%[ob:%'`,
  ];
  if (range?.startDate) predicates.push(gte(journalEntriesTable.entryDate, range.startDate));
  if (range?.endDate) predicates.push(lte(journalEntriesTable.entryDate, range.endDate));

  const rows = await db.select({
    id: journalEntriesTable.id,
    docNumber: journalEntriesTable.docNumber,
    entryDate: journalEntriesTable.entryDate,
    debit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`,
    credit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`,
  })
    .from(journalEntriesTable)
    .leftJoin(journalEntryLinesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(...predicates))
    .groupBy(journalEntriesTable.id);

  return rows.filter((row) =>
    Math.abs(Number(row.debit || 0) - Number(row.credit || 0)) > 0.005,
  );
}