import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDragSelection,
  selectionContainsCenter,
  selectionIntersects,
} from "../src/pages/printDesigner/selection.ts";

test("drag selection normalizes a right-to-left and bottom-to-top gesture", () => {
  assert.deepEqual(
    normalizeDragSelection({ x1: 180, y1: 120, x2: 40, y2: 20 }),
    { left: 40, top: 20, right: 180, bottom: 120 },
  );
});

test("selection can identify a column or field by its visible bounds", () => {
  const selection = normalizeDragSelection({ x1: 80, y1: 30, x2: 140, y2: 90 });
  assert.equal(selectionIntersects(selection, { left: 120, top: 40, right: 200, bottom: 80 }), true);
  assert.equal(selectionIntersects(selection, { left: 141, top: 40, right: 200, bottom: 80 }), false);
  assert.equal(selectionContainsCenter(selection, { left: 70, top: 20, right: 130, bottom: 100 }), true);
});
