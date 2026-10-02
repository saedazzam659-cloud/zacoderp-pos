export type ReversibleJournalEntryLine = {
  id?: number;
  entryId?: number;
  accountId: number | null;
  costCenter: string | null;
  projectId: number | null;
  debit: string;
  credit: string;
  description: string | null;
  supplierName?: string | null;
  supplierVatNumber?: string | null;
  supplierInvoiceNumber?: string | null;
  supplierInvoiceDate?: string | null;
  sortOrder?: number;
};

export function reverseJournalEntryLines(
  lines: ReversibleJournalEntryLine[],
): Omit<ReversibleJournalEntryLine, "id" | "entryId">[] {
  return lines.map((line) => {
    const { id, entryId, ...copy } = line;
    void id;
    void entryId;
    return {
      ...copy,
      debit: line.credit,
      credit: line.debit,
    };
  });
}