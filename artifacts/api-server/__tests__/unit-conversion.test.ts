import assert from "node:assert/strict";
import test from "node:test";
import {
  divideQuantity,
  multiplyQuantity,
  rebaseUnitGraph,
  resolveUnitGraph,
  canClearLegacyConversionConflictAfterExplicitEdit,
  roundQuantity,
  toStorageDecimal,
  UnitConversionError,
  validateBaseUnitAssignment,
  assertUnitGraphTenantOwnership,
  isExactBaseUnitRequest,
} from "../src/lib/unitConversion.js";

test("only the exact saved base unit is safe when alternate conversion data conflicts", () => {
  assert.equal(isExactBaseUnitRequest(7, "KG", "KG"), true);
  assert.equal(isExactBaseUnitRequest(7, "KG", "BOX"), false);
  assert.equal(isExactBaseUnitRequest(null, "KG", "KG"), false);
  assert.equal(isExactBaseUnitRequest(7, null, "KG"), false);
});

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

test("an explicit edit may clear a stale marker on a valid graph with no history", () => {
  const rows = [
    {
      id: 77,
      unitId: 47,
      referenceUnitId: 46,
      relationFactor: "12",
      isBase: false,
      isActive: true,
      legacyConversionConflict: true,
    },
  ];
  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 46,
    editedRowId: 77,
    rows,
    historicalUsage: false,
  }), true);

  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 46,
    editedRowId: 77,
    rows,
    historicalUsage: true,
  }), false);
  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 46,
    editedRowId: 77,
    rows: [{ ...rows[0], referenceUnitId: 999 }],
    historicalUsage: false,
  }), false);
});

test("a used multi-unit item may clear a stale non-base marker without changing its conversion", () => {
  const previousRows = [{
    id: 91,
    unitId: 42,
    referenceUnitId: 50,
    relationFactor: "1000.000000000000000000",
    conversionFactor: "1000.000000000000000000",
    isBase: true,
    isActive: true,
    legacyConversionConflict: true,
  }];
  const correctedRows = previousRows.map((row) => ({
    ...row,
    isBase: false,
  }));

  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 50,
    editedRowId: 91,
    rows: correctedRows,
    previousRows,
    historicalUsage: true,
  }), true);

  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 50,
    editedRowId: 91,
    rows: [{ ...correctedRows[0], relationFactor: "1001" }],
    previousRows,
    historicalUsage: true,
  }), false, "changing the conversion factor could reinterpret historical quantities");

  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 50,
    editedRowId: 91,
    rows: [{ ...correctedRows[0], referenceUnitId: 51 }],
    previousRows,
    historicalUsage: true,
  }), false, "changing the reference edge is not a marker-only repair");

  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 50,
    editedRowId: 91,
    rows: [{ ...correctedRows[0], isActive: false }],
    previousRows,
    historicalUsage: true,
  }), false, "disabling the unit changes the available conversion graph");

  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 50,
    editedRowId: 91,
    rows: correctedRows,
    previousRows: [{ ...previousRows[0], conversionFactor: "999" }],
    historicalUsage: true,
  }), false, "a stale cached factor cannot be silently reconciled over historical use");
});

test("one explicit edit can clear migration markers from a valid graph, but not when used", () => {
  const rows = [
    { id: 76, unitId: 46, referenceUnitId: null, relationFactor: "1", isBase: true,
      isActive: true, legacyConversionConflict: true },
    { id: 77, unitId: 47, referenceUnitId: 46, relationFactor: "12", isBase: false,
      isActive: true, legacyConversionConflict: true },
  ];
  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 46, editedRowId: 77, rows, historicalUsage: false,
  }), true);
  assert.equal(canClearLegacyConversionConflictAfterExplicitEdit({
    baseUnitId: 46, editedRowId: 77, rows, historicalUsage: true,
  }), false);
});

test("used legacy unitless quantities may receive their first base unit", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: null,
    requestedBaseUnitId: 7,
    rows: [],
    historicalUsage: true,
    historicalUnitIds: [null, 7],
  });
  assert.deepEqual(decision, { allowed: true, clearLegacyConflict: false });
});

test("used legacy items can initialize a compatible unmarked unit graph from an explicit base choice", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: null,
    requestedBaseUnitId: 7,
    rows: [
      { unitId: 7, referenceUnitId: null, relationFactor: "1", isBase: false },
      { unitId: 8, referenceUnitId: 7, relationFactor: "12", isBase: false },
    ],
    historicalUsage: true,
    historicalUnitIds: [null, 8],
  });
  assert.deepEqual(decision, {
    allowed: true,
    clearLegacyConflict: false,
    markBaseUnit: true,
  });
});

test("a legacy first unit link may initialize its reference as base when it covers historical unit labels", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: null,
    requestedBaseUnitId: 7,
    rows: [
      { unitId: 7, referenceUnitId: null, relationFactor: "1", conversionFactor: "1", isBase: true },
      { unitId: 8, referenceUnitId: 7, relationFactor: "12", conversionFactor: "12", isBase: false },
    ],
    historicalUsage: true,
    historicalUnitIds: [null, 8],
  });
  assert.deepEqual(decision, { allowed: true, clearLegacyConflict: false });
});

test("legacy first unit initialization still blocks historical units not covered by the proposed link", () => {
  assert.throws(
    () => validateBaseUnitAssignment({
      currentBaseUnitId: null,
      requestedBaseUnitId: 7,
      rows: [
        { unitId: 7, referenceUnitId: null, relationFactor: "1", conversionFactor: "1", isBase: true },
        { unitId: 8, referenceUnitId: 7, relationFactor: "12", conversionFactor: "12", isBase: false },
      ],
      historicalUsage: true,
      historicalUnitIds: [9],
    }),
    (error: unknown) => error instanceof UnitConversionError && error.code === "BASE_CHANGE_BLOCKED",
  );
});

test("an explicit first base normalizes flat legacy unit rows from their saved conversion factors", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: null,
    requestedBaseUnitId: 7,
    rows: [
      { unitId: 7, referenceUnitId: null, relationFactor: "1", conversionFactor: "1", isBase: false },
      { unitId: 8, referenceUnitId: null, relationFactor: "1", conversionFactor: "12", isBase: false, legacyConversionConflict: true },
    ],
    historicalUsage: true,
    historicalUnitIds: [null, 8],
  });
  assert.deepEqual(decision, {
    allowed: true,
    clearLegacyConflict: false,
    normalizeLegacyRoots: true,
  });
});

test("flat legacy units cannot be normalized when a historical unit is outside the saved graph", () => {
  assert.throws(
    () => validateBaseUnitAssignment({
      currentBaseUnitId: null,
      requestedBaseUnitId: 7,
      rows: [
        { unitId: 7, referenceUnitId: null, relationFactor: "1", conversionFactor: "1", isBase: false },
        { unitId: 8, referenceUnitId: null, relationFactor: "1", conversionFactor: "12", isBase: false },
      ],
      historicalUsage: true,
      historicalUnitIds: [99],
    }),
    (error: unknown) => error instanceof UnitConversionError && error.code === "AMBIGUOUS_BASE",
  );
});

test("a different historical unit still blocks an unlinked first base", () => {
  assert.throws(
    () => validateBaseUnitAssignment({
      currentBaseUnitId: null,
      requestedBaseUnitId: 7,
      rows: [],
      historicalUsage: true,
      historicalUnitIds: [8],
    }),
    (error: unknown) => error instanceof UnitConversionError && error.code === "BASE_CHANGE_BLOCKED",
  );
});

test("company opt-in allows a first base despite conflicting historical unit labels", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: null,
    requestedBaseUnitId: 7,
    rows: [],
    historicalUsage: true,
    historicalUnitIds: [8],
    allowHistoricalChanges: true,
  });
  assert.deepEqual(decision, { allowed: true, clearLegacyConflict: false });
});

test("company opt-in allows changing a base when only history blocks it", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: 7,
    requestedBaseUnitId: 8,
    rows: [],
    historicalUsage: true,
    historicalUnitIds: [7],
    allowHistoricalChanges: true,
  });
  assert.deepEqual(decision, { allowed: true, clearLegacyConflict: false });
});

test("company opt-in still requires the new base to be linked in the graph", () => {
  assert.throws(
    () => validateBaseUnitAssignment({
      currentBaseUnitId: 7,
      requestedBaseUnitId: 8,
      rows: [{ unitId: 7, referenceUnitId: null, relationFactor: "1", isBase: true }],
      historicalUsage: true,
      historicalUnitIds: [7],
      allowHistoricalChanges: true,
    }),
    (error: unknown) => error instanceof UnitConversionError && error.code === "BASE_CHANGE_BLOCKED",
  );
});

test("company opt-in marks a valid linked graph for rerooting", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: 1,
    requestedBaseUnitId: 2,
    rows: [
      { unitId: 1, referenceUnitId: null, relationFactor: "1", isBase: true },
      { unitId: 2, referenceUnitId: 1, relationFactor: "4" },
    ],
    historicalUsage: true,
    historicalUnitIds: [9],
    allowHistoricalChanges: true,
  });
  assert.deepEqual(decision, { allowed: true, clearLegacyConflict: false, rebaseGraph: true });
});

test("company opt-in reroots a linked conversion tree without changing terminating ratios", () => {
  const rows = [
    { unitId: 1, referenceUnitId: null, relationFactor: "1", isBase: true },
    { unitId: 2, referenceUnitId: 1, relationFactor: "4" },
    { unitId: 3, referenceUnitId: 2, relationFactor: "2" },
    { unitId: 4, referenceUnitId: 1, relationFactor: "5" },
  ];
  const rebased = rebaseUnitGraph(1, 2, rows);
  const graph = resolveUnitGraph({ baseUnitId: 2, rows: rebased });
  assert.deepEqual(
    [...graph.factors.entries()].sort(([a], [b]) => a - b),
    [[1, "0.25"], [2, "1"], [3, "2"], [4, "1.25"]],
  );
  assert.equal(rebased.find((row) => row.unitId === 1)?.referenceUnitId, 2);
  assert.equal(rebased.find((row) => row.unitId === 1)?.relationFactor, "0.250000000000000000");
  assert.equal(rebased.find((row) => row.unitId === 2)?.isBase, true);
});

test("company opt-in reroots preserve inactive mappings without using them as conversion edges", () => {
  const rows = [
    { unitId: 1, referenceUnitId: null, relationFactor: "1", isBase: true },
    { unitId: 2, referenceUnitId: 1, relationFactor: "4" },
    { unitId: 9, referenceUnitId: 1, relationFactor: "7", isActive: false },
  ];
  const rebased = rebaseUnitGraph(1, 2, rows);
  assert.equal(rebased.find((row) => row.unitId === 9)?.referenceUnitId, 1);
  assert.equal(rebased.find((row) => row.unitId === 9)?.isBase, false);
  assert.equal(resolveUnitGraph({ baseUnitId: 2, rows: rebased }).factors.get(1), "0.25");
});

test("only a proven sole legacy base may clear its conflict marker", () => {
  const decision = validateBaseUnitAssignment({
    currentBaseUnitId: null,
    requestedBaseUnitId: 7,
    rows: [{
      unitId: 7,
      referenceUnitId: null,
      relationFactor: "12",
      isBase: false,
      legacyConversionConflict: true,
    }],
    historicalUsage: true,
    historicalUnitIds: [null],
  });
  assert.deepEqual(decision, { allowed: true, clearLegacyConflict: true });
});

test("used established base units cannot be switched", () => {
  assert.throws(
    () => validateBaseUnitAssignment({
      currentBaseUnitId: 7,
      requestedBaseUnitId: 8,
      rows: [{ unitId: 7, referenceUnitId: null, relationFactor: "1", isBase: true }],
      historicalUsage: true,
      historicalUnitIds: [7],
    }),
    (error: unknown) => error instanceof UnitConversionError && error.code === "BASE_CHANGE_BLOCKED",
  );
});

test("ambiguous item-unit relationships remain blocked during first assignment", () => {
  assert.throws(
    () => validateBaseUnitAssignment({
      currentBaseUnitId: null,
      requestedBaseUnitId: 7,
      rows: [
        { unitId: 7, referenceUnitId: null, relationFactor: "1", isBase: false },
        { unitId: 8, referenceUnitId: null, relationFactor: "1", isBase: false },
      ],
      historicalUsage: true,
      historicalUnitIds: [null],
    }),
    (error: unknown) => error instanceof UnitConversionError && error.code === "AMBIGUOUS_BASE",
  );
});

test("item-unit source and reference ids must all belong to the tenant", () => {
  assert.throws(
    () => assertUnitGraphTenantOwnership(
      [{ unitId: 7, referenceUnitId: 99, relationFactor: "2" }],
      [7],
      7,
    ),
    (error: unknown) => error instanceof UnitConversionError
      && error.code === "UNIT_NOT_FOUND"
      && error.details?.unitId === 99,
  );
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
