import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("historical migration previews dates and monthly fiscal periods without writing", async () => {
  const source = await readFile(new URL("../src/routes/data-io.ts", import.meta.url), "utf8");
  const scanStart = source.indexOf('router.post("/import/historical/scan"');
  const scanEnd = source.indexOf('router.post("/import/historical/ensure-years"', scanStart);
  const scan = source.slice(scanStart, scanEnd);
  assert.match(scan, /firstDate: dates\[0\]/);
  assert.match(scan, /lastDate: dates\[dates\.length - 1\]/);
  assert.match(scan, /periodsProposed/);
  assert.match(scan, /closedPeriodConflicts/);
});

test("period creation requires explicit approval and records the created periods", async () => {
  const source = await readFile(new URL("../src/routes/data-io.ts", import.meta.url), "utf8");
  assert.match(source, /req\.body\?\.approved !== true/);
  assert.match(source, /buildHistoricalMonthlyPeriods\(yearRow\.startDate, yearRow\.endDate\)/);
  assert.match(source, /metadata: \{ approved: true, yearsCreated: created, periods: createdPeriodRanges \}/);
});

test("historical commit refuses missing or closed periods instead of creating them", async () => {
  const source = await readFile(new URL("../src/routes/data-io.ts", import.meta.url), "utf8");
  const start = source.indexOf('router.post("/import/historical/commit"');
  const commit = source.slice(start);
  assert.match(commit, /Never create fiscal years or periods as a side effect/);
  assert.match(commit, /period\.status !== "open"/);
  assert.match(commit, /res\.status\(409\)\.json/);
  assert.match(commit, /currentPeriod\.status !== "open"/);
});

test("historical migration UI separates period approval from import and allows date review", async () => {
  const source = await readFile(new URL("../../zatca-invoicing/src/pages/settings/HistoricalMigration.tsx", import.meta.url), "utf8");
  assert.match(source, /أوافق على إنشاء الفترات الشهرية المقترحة/);
  assert.match(source, /input-fiscal-year-start-/);
  assert.match(source, /input-fiscal-year-end-/);
  assert.match(source, /!periodsApproved/);
});
