import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveBundleAssemblyUnitCost,
  parseBundleAssemblyRequestId,
} from "../src/lib/bundleAssemblyCost.js";

describe("deriveBundleAssemblyUnitCost", () => {
  it("divides actual material issue value by finished output quantity", () => {
    assert.equal(deriveBundleAssemblyUnitCost(13.8, 2), 6.9);
  });

  it("rounds to the inventory unit-cost precision", () => {
    assert.equal(deriveBundleAssemblyUnitCost(1, 3), 0.3333);
  });

  it("rejects invalid cost or output quantity", () => {
    assert.throws(() => deriveBundleAssemblyUnitCost(-1, 1));
    assert.throws(() => deriveBundleAssemblyUnitCost(1, 0));
    assert.throws(() => deriveBundleAssemblyUnitCost(Number.NaN, 1));
  });

  it("reads only a well-formed stable request reference from the adjustment notes", () => {
    const requestId = "a72d03e7-7ab0-4e4d-9f7d-112233445566";
    assert.equal(parseBundleAssemblyRequestId(`Assembly [bundle-assembly-request:${requestId}]`), requestId);
    assert.equal(parseBundleAssemblyRequestId("Assembly without request marker"), null);
    assert.equal(parseBundleAssemblyRequestId("[bundle-assembly-request:not-a-uuid]"), null);
  });
});