import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeBundleAssembly } from "../src/pages/inventory/bundleAssembly";

describe("summarizeBundleAssembly", () => {
  it("prices the finished quantity from the selected warehouse material cost", () => {
    const summary = summarizeBundleAssembly(
      [
        { itemId: 10, qty: "2.5" },
        { itemId: 11, qty: "3" },
      ],
      [
        { itemId: 10, qty: "20", avgCost: "4.20" },
        { itemId: 11, qty: "8", avgCost: "1.10" },
      ],
      "2",
    );

    assert.equal(summary.materialCost, 13.8);
    assert.equal(summary.unitCost, 6.9);
    assert.deepEqual(summary.shortages, []);
  });

  it("reports shortages after aggregating repeated material rows", () => {
    const summary = summarizeBundleAssembly(
      [
        { itemId: 10, qty: "2" },
        { itemId: 10, qty: "1.5" },
      ],
      [{ itemId: 10, qty: "3", avgCost: "2" }],
      "1",
    );

    assert.deepEqual(summary.shortages, [
      { itemId: 10, requested: 3.5, available: 3, shortfall: 0.5 },
    ]);
    assert.equal(summary.materialCost, 7);
  });

  it("rejects non-positive quantities instead of silently costing them", () => {
    const summary = summarizeBundleAssembly(
      [{ itemId: 10, qty: "0" }],
      [{ itemId: 10, qty: "10", avgCost: "3" }],
      "1",
    );

    assert.deepEqual(summary.invalidItemIds, [10]);
    assert.equal(summary.materialCost, 0);
  });
});