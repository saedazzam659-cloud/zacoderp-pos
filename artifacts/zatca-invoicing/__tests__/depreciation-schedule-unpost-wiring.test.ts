import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/pages/fixed-assets/DepreciationScheduleTimeline.tsx", import.meta.url),
  "utf8",
);

test("schedule unpost action is limited to persisted posted runs", () => {
  assert.match(source, /r\.runStatus === "posted" && r\.runId != null/);
  assert.match(source, /data-testid=\{`depreciation-schedule-unpost-\$\{r\.runId\}`\}/);
  assert.doesNotMatch(source, /journal-entries\/\$\{r\.runId\}\/unpost/);
});

test("schedule unpost uses the fixed-assets run endpoint and row-local pending state", () => {
  assert.match(source, /fixed-assets\/depreciation\/\$\{runId\}\/unpost/);
  assert.match(source, /unpostMutation\.variables === r\.runId/);
  assert.match(source, /window\.confirm\("[^"]*إلغاء ترحيل[^"]*"\)/);
});

test("schedule unpost surfaces server errors and refreshes all dependent data", () => {
  assert.match(source, /throw new Error\(payload\.error \|\|/);
  assert.match(source, /description: error\.message/);
  assert.match(source, /queryKey: \["fa\/dep-schedule"\]/);
  assert.match(source, /queryKey: \["fa\/dep-runs"\]/);
  assert.match(source, /queryKey: \["fa\/assets"\]/);
});