import assert from "node:assert/strict";
import test from "node:test";
import { resolveSalesItemUnitPrice } from "../src/lib/salesItemPricing.ts";

test("base unit uses the item editor sale price", () => {
  assert.equal(
    resolveSalesItemUnitPrice({ salePrice: "126" }, { isBase: true, salePrice: "124" }),
    "126",
  );
});

test("alternate units keep their configured unit price", () => {
  assert.equal(
    resolveSalesItemUnitPrice({ salePrice: "126" }, { isBase: false, salePrice: "250" }),
    "250",
  );
});

test("base unit falls back to its unit price when the item price is unset or zero", () => {
  assert.equal(resolveSalesItemUnitPrice({ salePrice: "0" }, { isBase: true, salePrice: "124" }), "124");
  assert.equal(resolveSalesItemUnitPrice({}, { isBase: true, salePrice: "124" }), "124");
});

test("item sale price fills in when there is no configured unit row", () => {
  assert.equal(resolveSalesItemUnitPrice({ salePrice: "126" }, undefined), "126");
});
