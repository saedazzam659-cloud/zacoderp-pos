import assert from "node:assert/strict";
import test from "node:test";
import { generateClothingVariantIdentifiers } from "../src/lib/clothingVariantIdentifiers.js";

test("generates stable Code 128 identifiers from model, color, and size", () => {
  const input = { parentItemId: 42, parentCode: "SH-240", color: "كحلي", size: "L" };
  const first = generateClothingVariantIdentifiers(input, new Set(), new Set());
  const second = generateClothingVariantIdentifiers(input, new Set(), new Set());

  assert.deepEqual(second, first);
  assert.match(first.code, /^SH-240-16-/);
  assert.match(first.barcode, /^C16/);
});

test("different combinations receive different defaults within a batch", () => {
  const usedCodes = new Set<string>();
  const usedBarcodes = new Set<string>();
  const first = generateClothingVariantIdentifiers(
    { parentItemId: 42, parentCode: "SH-240", color: "كحلي", size: "L" },
    usedCodes,
    usedBarcodes,
  );
  const second = generateClothingVariantIdentifiers(
    { parentItemId: 42, parentCode: "SH-240", color: "كحلي", size: "M" },
    usedCodes,
    usedBarcodes,
  );

  assert.notEqual(first.code, second.code);
  assert.notEqual(first.barcode, second.barcode);
  assert.equal(usedCodes.size, 2);
  assert.equal(usedBarcodes.size, 2);
});

test("avoids collisions with existing item codes and barcodes", () => {
  const input = { parentItemId: 42, parentCode: "SH-240", color: "كحلي", size: "L" };
  const initial = generateClothingVariantIdentifiers(input, new Set(), new Set());
  const usedCodes = new Set([initial.code.toLocaleLowerCase()]);
  const usedBarcodes = new Set([initial.barcode.toLocaleLowerCase()]);
  const next = generateClothingVariantIdentifiers(input, usedCodes, usedBarcodes);

  assert.equal(next.code, `${initial.code}-2`);
  assert.equal(next.barcode, `${initial.barcode}-2`);
});
