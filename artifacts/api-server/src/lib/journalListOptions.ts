const JOURNAL_SORT_KEYS = new Set([
  "doc", "date", "type", "desc", "status", "createdBy", "postedBy", "debit", "credit",
]);

/** Parse journal-register controls without passing user identifiers to SQL. */
export function journalListOptions(query: Record<string, unknown>) {
  const raw = (key: string) => Array.isArray(query[key]) ? query[key][0] : query[key];
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(raw(key));
    return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const text = (key: string) => {
    const value = raw(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const date = (key: string) => {
    const value = text(key);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  };
  const sortKey = text("sortKey");
  const status = text("status");
  return {
    page: integer("page", 1, 1, Number.MAX_SAFE_INTEGER),
    // Normal screens request 10-250 rows. The higher cap is reserved for the
    // explicit "عرض الكل" choice and on-demand exports, never the initial load.
    limit: integer("limit", 50, 1, 5_000),
    q: text("q"),
    status: ["draft", "posted", "voided"].includes(status) ? status : "",
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
    sortKey: JOURNAL_SORT_KEYS.has(sortKey) ? sortKey : "createdAt",
    sortDir: text("sortDir").toLowerCase() === "asc" ? "asc" as const : "desc" as const,
    view: text("view"),
    paged: ["page", "limit", "q", "status", "dateFrom", "dateTo", "sortKey", "sortDir"]
      .some(key => raw(key) != null),
  };
}