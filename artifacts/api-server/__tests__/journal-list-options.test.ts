import test from "node:test";
import assert from "node:assert/strict";
import { journalListOptions } from "../src/lib/journalListOptions.ts";

test("journal list options clamp paging and allowlist sort/status", () => {
  const parsed = journalListOptions({
    page: "-5",
    limit: "999999",
    sortKey: "drop table",
    sortDir: "ASC",
    status: "not-a-status",
  });
  assert.equal(parsed.page, 1);
  assert.equal(parsed.limit, 250);
  assert.equal(parsed.sortKey, "createdAt");
  assert.equal(parsed.sortDir, "asc");
  assert.equal(parsed.status, "");
});

test("journal list options default and legacy show-all requests stay bounded", () => {
  assert.equal(journalListOptions({ page: "1" }).limit, 50);
  assert.equal(journalListOptions({ page: "1", limit: "5000" }).limit, 250);
});

test("journal list options accept valid filters and detect paged mode", () => {
  const parsed = journalListOptions({
    page: "2",
    limit: "50",
    q: "QYD/08",
    status: "posted",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    sortKey: "debit",
    sortDir: "desc",
  });
  assert.deepEqual(
    {
      page: parsed.page, limit: parsed.limit, q: parsed.q, status: parsed.status,
      dateFrom: parsed.dateFrom, dateTo: parsed.dateTo,
      sortKey: parsed.sortKey, sortDir: parsed.sortDir, paged: parsed.paged,
    },
    {
      page: 2, limit: 50, q: "QYD/08", status: "posted",
      dateFrom: "2026-08-01", dateTo: "2026-08-31",
      sortKey: "debit", sortDir: "desc", paged: true,
    },
  );
});