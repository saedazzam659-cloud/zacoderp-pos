import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveJournalEntryRouteIds } from "../src/lib/journalEntryRoute.ts";

test("new journal route uses the from id instead of treating new as an edit id", () => {
  assert.deepEqual(
    resolveJournalEntryRouteIds({ isNew: true, routeId: "new", fromParam: "31744" }),
    { editId: null, fromId: 31744, sourceId: 31744 },
  );
});

test("edit journal route keeps its route id and ignores duplicate source", () => {
  assert.deepEqual(
    resolveJournalEntryRouteIds({ isNew: false, routeId: "31744", fromParam: "812" }),
    { editId: 31744, fromId: null, sourceId: 31744 },
  );
});

test("invalid journal ids do not trigger a source load", () => {
  assert.deepEqual(
    resolveJournalEntryRouteIds({ isNew: true, routeId: "new", fromParam: "not-an-id" }),
    { editId: null, fromId: null, sourceId: null },
  );
});
