import { and, eq } from "drizzle-orm";
import { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";

/**
 * Read and validate the JE currently linked from a source document. The source
 * row's FK is the provenance link; entryType and companyId provide the checks
 * needed before changing its lifecycle.
 */
export async function getLinkedSourceJournalEntry(
  executor: any,
  companyId: number,
  entryId: number,
  entryType: string,
) {
  const [entry] = await executor.select().from(journalEntriesTable).where(and(
    eq(journalEntriesTable.id, entryId),
    eq(journalEntriesTable.companyId, companyId),
  )).limit(1);
  if (!entry || entry.entryType !== entryType || !["draft", "posted"].includes(entry.status)) {
    throw Object.assign(
      new Error("تعذر متابعة العملية لأن القيد المرتبط غير موجود أو لا يطابق نوع المستند."),
      { status: 409 },
    );
  }
  return entry;
}

/** Return the already-linked entry to draft without deleting its number or audit row. */
export async function draftLinkedSourceJournalEntry(
  executor: any,
  companyId: number,
  entryId: number,
  entryType: string,
) {
  const entry = await getLinkedSourceJournalEntry(executor, companyId, entryId, entryType);
  await executor.update(journalEntriesTable).set({
    status: "draft",
    updatedAt: new Date(),
  }).where(and(
    eq(journalEntriesTable.id, entryId),
    eq(journalEntriesTable.companyId, companyId),
  ));
  return entry;
}

/**
 * Rebuild a retained source-generated JE in place. Callers must pass their
 * transaction executor so source status/FK, header, and line replacement commit
 * atomically. Its number and creation audit remain unchanged.
 */
export async function replaceLinkedSourceJournalEntry(
  executor: any,
  options: {
    companyId: number;
    entryId: number;
    entryType: string;
    header: Record<string, unknown>;
    lines: Array<Record<string, unknown>>;
    sequenceProtected?: boolean;
  },
): Promise<number> {
  const entry = await getLinkedSourceJournalEntry(
    executor,
    options.companyId,
    options.entryId,
    options.entryType,
  );
  if (entry.status !== "draft") {
    throw Object.assign(
      new Error("لا يمكن إعادة بناء القيد المرتبط قبل فك ترحيله من المستند المصدر."),
      { status: 409 },
    );
  }

  const header = { ...options.header };
  for (const key of [
    "id", "companyId", "docNumber", "entryType",
    "createdBy", "createdIp", "createdUserAgent", "createdAt",
  ]) delete header[key];

  await executor.update(journalEntriesTable).set({
    ...header,
    companyId: options.companyId,
    docNumber: entry.docNumber,
    entryType: options.entryType,
    isSequenceProtected: !!entry.isSequenceProtected || !!options.sequenceProtected,
    updatedAt: new Date(),
  } as any).where(and(
    eq(journalEntriesTable.id, entry.id),
    eq(journalEntriesTable.companyId, options.companyId),
  ));

  await executor.delete(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.entryId, entry.id));
  if (options.lines.length) {
    await executor.insert(journalEntryLinesTable).values(
      options.lines.map((line) => ({ ...line, entryId: entry.id })) as any,
    );
  }
  return entry.id;
}