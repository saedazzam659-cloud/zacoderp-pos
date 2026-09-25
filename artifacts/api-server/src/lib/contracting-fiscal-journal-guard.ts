/** Accepted 386 accruals have no generic-journal correction route. Even if an
 * old entry was renamed, its authoritative fiscal source link still locks it. */
export const FISCAL_ADVANCE_JE_TYPE = "contracting_taxable_advance_invoice";

export function isFiscalAdvanceJournalLocked(
  entryType: string | null | undefined,
  hasFiscalSource: boolean,
): boolean {
  return entryType === FISCAL_ADVANCE_JE_TYPE || hasFiscalSource;
}