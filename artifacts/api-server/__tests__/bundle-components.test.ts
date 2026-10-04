import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BundleComponentQuantityError,
  normalizeBundleComponentQuantity,
} from "../src/lib/bundleComponents.js";

describe("normalizeBundleComponentQuantity", () => {
  it("keeps quantities already entered in the base unit", () => {
    assert.equal(normalizeBundleComponentQuantity({
      qty: "2.375",
      unitId: 1,
      baseUnitId: 1,
      unitFactors: new Map(),
    }), "2.3750");
  });

  it("converts a selected alternate unit into the base inventory unit", () => {
    assert.equal(normalizeBundleComponentQuantity({
      qty: "1.5",
      unitId: 2,
      baseUnitId: 1,
      unitFactors: new Map([[2, "12"]]),
    }), "18.0000");
  });

  it("rounds non-terminating conversions to the stored inventory precision", () => {
    assert.equal(normalizeBundleComponentQuantity({
      qty: "1",
      unitId: 2,
      baseUnitId: 1,
      unitFactors: new Map([[2, "0.333333333333333333"]]),
    }), "0.3333");
  });

  it("rejects a missing unit for a unit-based item and unconfigured alternate units", () => {
    assert.throws(
      () => normalizeBundleComponentQuantity({
        qty: "1",
        unitId: null,
        baseUnitId: 1,
        unitFactors: new Map(),
      }),
      (error: unknown) => error instanceof BundleComponentQuantityError && error.code === "UNIT_REQUIRED",
    );
    assert.throws(
      () => normalizeBundleComponentQuantity({
        qty: "1",
        unitId: 2,
        baseUnitId: 1,
        unitFactors: new Map(),
      }),
      (error: unknown) => error instanceof BundleComponentQuantityError && error.code === "INVALID_UNIT",
    );
  });

  it("rejects invalid and too-small quantities", () => {
    assert.throws(() => normalizeBundleComponentQuantity({
      qty: "0",
      unitId: 1,
      baseUnitId: 1,
      unitFactors: new Map(),
    }));
    assert.throws(() => normalizeBundleComponentQuantity({
      qty: "0.00001",
      unitId: 2,
      baseUnitId: 1,
      unitFactors: new Map([[2, "0.00001"]]),
    }));
  });
});