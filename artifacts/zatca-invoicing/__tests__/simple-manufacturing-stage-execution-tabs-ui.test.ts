import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const execution = readFileSync(
  new URL("../src/components/ProductionStageExecution.tsx", import.meta.url),
  "utf8",
);

test("production stage tabs stay readable and color-coded for variable route lengths", () => {
  assert.match(execution, /const STAGE_TAB_TONES = \[/);
  assert.match(execution, /stages\.map\(\(stage, idx\) => \{/);
  assert.match(execution, /STAGE_TAB_TONES\[idx % STAGE_TAB_TONES\.length\]/);
  assert.match(execution, /min-h-\[60px\][\s\S]*?min-w-max/);
  assert.match(execution, /snap-x snap-proximity[\s\S]*?overflow-x-auto/);
  assert.match(execution, /aria-posinset=\{idx \+ 1\}/);
  assert.match(execution, /aria-setsize=\{stages\.length\}/);
});