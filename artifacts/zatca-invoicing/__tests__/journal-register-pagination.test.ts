import assert from "node:assert/strict";
import test from "node:test";

import {
  JOURNAL_REGISTER_DEFAULT_PAGE_SIZE,
  JOURNAL_REGISTER_PAGE_SIZES,
  safeJournalRegisterPageSize,
} from "../src/lib/journalRegisterPaging.ts";

test("journal register migrates legacy show-all paging to a safe first page", () => {
  assert.equal(safeJournalRegisterPageSize(0), JOURNAL_REGISTER_DEFAULT_PAGE_SIZE);
  assert.equal(safeJournalRegisterPageSize("0"), JOURNAL_REGISTER_DEFAULT_PAGE_SIZE);
  assert.equal(safeJournalRegisterPageSize(5000), JOURNAL_REGISTER_DEFAULT_PAGE_SIZE);
});

test("journal register accepts only its bounded page-size choices", () => {
  for (const pageSize of JOURNAL_REGISTER_PAGE_SIZES) {
    assert.equal(safeJournalRegisterPageSize(pageSize), pageSize);
  }
});