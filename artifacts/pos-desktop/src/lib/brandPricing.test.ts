import test from "node:test";
import assert from "node:assert/strict";
import {
  brandDiscountForLine,
  calculateBrandNetPrice,
  calculateBrandSalePrice,
} from "./brandPricing.ts";

test("brand price increase and decrease support percent and fixed amounts", () => {
  assert.equal(calculateBrandSalePrice(100, "increase", "percent", 15), 115);
  assert.equal(calculateBrandSalePrice(100, "decrease", "percent", 15), 85);
  assert.equal(calculateBrandSalePrice(100, "increase", "amount", 12.5), 112.5);
  assert.equal(calculateBrandSalePrice(100, "decrease", "amount", 12.5), 87.5);
});

test("brand price reductions never create a negative sale price", () => {
  assert.equal(calculateBrandSalePrice(10, "decrease", "amount", 15), 0);
  assert.equal(calculateBrandSalePrice(10, "decrease", "percent", 150), 0);
});

test("brand discounts calculate percent or fixed net price safely", () => {
  assert.equal(calculateBrandNetPrice(200, "percent", 10), 180);
  assert.equal(calculateBrandNetPrice(200, "amount", 15), 185);
  assert.equal(calculateBrandNetPrice(10, "amount", 15), 0);
  assert.equal(calculateBrandNetPrice(100, "none", 20), 100);
});

test("fixed brand discounts scale by line quantity", () => {
  assert.deepEqual(brandDiscountForLine({ discountType: "amount", discountValue: 5 }, 3), {
    disc: 15,
    discType: "value",
  });
  assert.deepEqual(brandDiscountForLine({ discountType: "percent", discountValue: 12 }, 3), {
    disc: 12,
    discType: "percent",
  });
});
