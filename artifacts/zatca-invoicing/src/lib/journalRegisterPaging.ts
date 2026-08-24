export const JOURNAL_REGISTER_PAGE_SIZES = [10, 25, 50, 100, 250] as const;
export const JOURNAL_REGISTER_DEFAULT_PAGE_SIZE = 50;

/**
 * The journal register must never translate the shared grid's legacy
 * `pageSize=0` ("show all") preference into an unbounded first paint. Older
 * tenants can still have that value in localStorage, so normalize it before
 * building the request as well as migrating the saved preference in the page.
 */
export function safeJournalRegisterPageSize(value: unknown): number {
  const size = Number(value);
  return (JOURNAL_REGISTER_PAGE_SIZES as readonly number[]).includes(size)
    ? size
    : JOURNAL_REGISTER_DEFAULT_PAGE_SIZE;
}