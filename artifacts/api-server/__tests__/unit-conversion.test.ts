import assert from "node:assert/strict";
import test from "node:test";
import {
  divideQuantity,
  multiplyQuantity,
  resolveUnitGraph,
  roundQuantity,
  toStorageDecimal,
  UnitConversionError,
} from "../src/lib/unitConversion.js";

test("carton x12 conversion and inverse stay exact", () => {
  assert.equal(multiplyQuantity("3", "12"), "36");
  assert.equal(divideQuantity("36", "12"), "3");
  assert.equal(divideQuantity("1", "12"), "1/12");
});

test("multi-level graph resolves every edge to one base", () => {
  const graph = resolveUnitGraph({
    baseUnitId: 1,
    rows: [
      { unitId: 1, referenceUnitId: null, relationFactor: "1", isBase: true },
      { unitId: 2, referenceUnitId: 1, relationFactor: "12" },
      { unitId: 3, referenceUnitId: 2, relationFactor: "4" },
    ],
  });
  assert.equal(graph.factors.get(1), "1");
  assert.equal(graph.factors.get(2), "12");
  assert.equal(graph.factors.get(3), "48");
});

test("only a sole unrooted item-unit mapping may repair a missing base", () => {
  const repaired = resolveUnitGraph({
    baseUnitId: null,
    rows: [
      // This is an item-owned row from the legacy item importer; it is not a
      // catalog conversion and has no other item unit to be ambiguous with.
      { unitId: 7, referenceUnitId: null, relationFactor: "12", isBase: false, legacyConversionConflict: true },
    ],
  });
  assert.equal(repaired.baseUnitId, 7);
  assert.equal(repaired.factors.get(7), "1");

  for (const rows of [
    [],
    [
      { unitId: 7, referenceUnitId: null, relationFactor: "1", isBase: false },
      { unitId: 8, referenceUnitId: null, relationFactor: "1", isBase: false },
    ],
    [
      { unitId: 7, referenceUnitId: null, relationFactor: "1", isBase: true },
      { unitId: 8, referenceUnitId: null, relationFactor: "1", isBase: true },
    ],
  ]) {
    assert.throws(
      () => resolveUnitGraph({ baseUnitId: null, rows }),
      (error: unknown) => error instanceof UnitConversionError && error.code === "AMBIGUOUS_BASE",
    );
  }
});

test("rational precision is not flattened by Number", () => {
  assert.equal(multiplyQuantity("0.1", "0.2"), "0.02");
  assert.equal(divideQuantity("1", "3"), "1/3");
  assert.equal(toStorageDecimal("1/3", 6), "0.333333");
});

test("rounding modes apply only to display/storage boundaries", () => {
  assert.equal(roundQuantity("1.235", 2, "half_up"), "1.24");
  assert.equal(roundQuantity("1.235", 2, "half_even"), "1.24");
  assert.equal(roundQuantity("1.234", 2, "floor"), "1.23");
});

test("cycles and duplicate active source units are rejected", () => {
  assert.throws(
    () => resolveUnitGraph({
      baseUnitId: 1,
      rows: [
        { unitId: 1, referenceUnitId: null, relationFactor: "1", isBase: true },
        { unitId: 2, referenceUnitId: 3, relationFactor: "2" },
        { unitId: 3, referenceUnitId: 2, relationFactor: "2" },
      ],
    }),
    /cycle/i,
  );
  assert.throws(
    () => resolveUnitGraph({
      baseUnitId: 1,
      rows: [
        { unitId: 1, referenceUnitId: null, relationFactor: "1", isBase: true },
        { unitId: 2, referenceUnitId: 1, relationFactor: "2" },
        { unitId: 2, referenceUnitId: 1, relationFactor: "3" },
      ],
    }),
    /only one active row/i,
  );
});
