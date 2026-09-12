import assert from "node:assert/strict";
import test from "node:test";
import { requireItemUnit } from "../src/lib/requiredItemUnit.js";

test("new items require a positive integral unit ID", () => {
  for (const value of [undefined, null, "", " ", 0, -1, 1.5, "bad", true, {}, []]) {
    assert.throws(() => requireItemUnit(value), /الوحدة الأساسية/);
  }
  assert.equal(requireItemUnit("12"), 12);
});

test("partial edits retain the existing unit, but cannot explicitly clear it", () => {
  assert.equal(requireItemUnit(undefined, 7), 7);
  for (const value of [null, "", 0]) {
    assert.throws(() => requireItemUnit(value, 7), /الوحدة الأساسية/);
  }
  assert.throws(() => requireItemUnit(undefined, null), /الوحدة الأساسية/);
});