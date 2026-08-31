import assert from "node:assert/strict";
import test from "node:test";

import { overlayScheduleRuns, type ScheduleRow } from "../src/lib/depreciationCalc.ts";

const schedule: ScheduleRow[] = [
  { year: 2026, month: 1, days: 31, amount: 100, cumulative: 100 },
  { year: 2026, month: 2, days: 28, amount: 100, cumulative: 200 },
  { year: 2026, month: 3, days: 31, amount: 100, cumulative: 300 },
];

test("overlays run identity and status without changing calculated schedule values", () => {
  const rows = overlayScheduleRuns(schedule, [
    { id: 71, periodYear: 2026, periodMonth: 1, status: "posted" },
    { id: 72, periodYear: 2026, periodMonth: 2, status: "unposted" },
  ]);

  assert.deepEqual(rows, [
    { ...schedule[0], posted: true, runId: 71, runStatus: "posted" },
    { ...schedule[1], posted: false, runId: 72, runStatus: "unposted" },
    { ...schedule[2], posted: false, runId: null, runStatus: null },
  ]);
  assert.deepEqual(
    rows.map(({ posted: _posted, runId: _runId, runStatus: _runStatus, ...calculated }) => calculated),
    schedule,
  );
});

test("only an actual posted run sets existing posted semantics", () => {
  const [row] = overlayScheduleRuns([schedule[0]], [
    { id: 80, periodYear: 2026, periodMonth: 1, status: "draft" },
    { id: 81, periodYear: 2026, periodMonth: 1, status: "posted" },
  ]);

  assert.equal(row.posted, true);
  assert.equal(row.runId, 81);
  assert.equal(row.runStatus, "posted");
});