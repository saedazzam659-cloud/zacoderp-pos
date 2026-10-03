import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manufacturing = readFileSync(
  new URL("../src/pages/SimpleManufacturing.tsx", import.meta.url),
  "utf8",
);
const wizard = readFileSync(
  new URL("../src/pages/simple-manufacturing/SimpleWizard.tsx", import.meta.url),
  "utf8",
);
const setup = readFileSync(
  new URL("../src/pages/simple-manufacturing/SimpleSetup.tsx", import.meta.url),
  "utf8",
);
const readonlyOrder = readFileSync(
  new URL("../src/pages/simple-manufacturing/SimpleOrderWizardReadonly.tsx", import.meta.url),
  "utf8",
);

test("Smart Manufacturing module tabs have distinct tinted and active colors", () => {
  const colors = {
    orders: "sky",
    new: "violet",
    setup: "amber",
    reports: "emerald",
  };

  for (const [tab, color] of Object.entries(colors)) {
    assert.match(
      manufacturing,
      new RegExp(`${tab}:\\s+"border-${color}-200 bg-${color}-50`),
    );
    assert.ok(manufacturing.includes(`MANUFACTURING_TAB_COLORS.${tab}`));
  }
});

test("new-order wizard color-codes all six stages and announces the active stage", () => {
  for (const color of ["sky", "teal", "amber", "violet", "blue", "emerald"]) {
    assert.ok(wizard.includes(`border-${color}-`), `missing ${color} stage color`);
  }

  for (const stage of ["basic", "materials", "routing", "resources", "costs", "review"]) {
    assert.ok(wizard.includes(`id: "${stage}"`), `missing ${stage} wizard stage`);
  }

  assert.match(wizard, /aria-current=\{active \? "step" : undefined\}/);
  assert.match(wizard, /role="status"[\s\S]*?aria-live="polite"[\s\S]*?manufacturing-wizard-step-status/);
  assert.match(wizard, /الخطوة \{activeStepIndex \+ 1\} من \{steps\.length\}/);
  assert.match(wizard, /data-testid=\{`planned-production-stage-\$\{i \+ 1\}`\}/);
});

test("planned routing stages and routing setup rows expose clear numbered visuals", () => {
  assert.match(setup, /data-testid=\{`routing-stage-editor-\$\{index \+ 1\}`\}/);
  assert.match(setup, /المرحلة \{index \+ 1\}/);
  assert.match(setup, /إضافة مرحلة/);
  assert.match(setup, /حذف المرحلة \$\{index \+ 1\}/);
});

test("saved order stages use the same six-step colors and preserve snapshot wording", () => {
  assert.match(readonlyOrder, /READONLY_STEP_COLORS/);
  assert.match(readonlyOrder, /aria-live="polite"[\s\S]*?الخطوة \{activeStepIndex \+ 1\} من \{steps\.length\}/);
  assert.match(readonlyOrder, /data-testid=\{`saved-production-stage-\$\{index \+ 1\}`\}/);
  assert.ok(readonlyOrder.includes("لا تُعرض مراحل المسار الحالي بدلاً منها"));
});