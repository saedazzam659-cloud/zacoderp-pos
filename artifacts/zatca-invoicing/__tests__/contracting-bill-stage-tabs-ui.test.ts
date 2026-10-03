import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const detail = readFileSync(
  new URL("../src/pages/ContractingProjectDetail.tsx", import.meta.url),
  "utf8",
);

test("bill editor separates stages by color and announces the active stage", () => {
  const stageColors = {
    metadata: "sky",
    execution: "teal",
    adjustments: "amber",
    payments: "violet",
    summary: "emerald",
  };

  for (const [stage, color] of Object.entries(stageColors)) {
    assert.match(
      detail,
      new RegExp(`${stage}:\\s+"border-${color}-200 bg-${color}-50`),
    );
    assert.ok(detail.includes(`BILL_EDITOR_TAB_CLASSES.${stage}`));
  }

  assert.match(detail, /aria-live="polite" aria-atomic="true"/);
  assert.match(
    detail,
    /المرحلة \{billEditorStageIndex \+ 1\} من \{BILL_EDITOR_STAGES\.length\}/,
  );
  assert.match(detail, /BILL_EDITOR_STAGE_DOT_CLASS\[billEditorTab\]/);
});