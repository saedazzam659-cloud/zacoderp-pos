import assert from "node:assert/strict";
import test from "node:test";
import { findLastPaintedRow } from "../src/lib/printCanvasPagination";

test("findLastPaintedRow ignores trailing white canvas space", () => {
  const width = 3;
  const height = 5;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const visiblePixel = (2 * width + 1) * 4;
  pixels[visiblePixel] = 20;

  assert.equal(findLastPaintedRow(pixels, width, height), 2);
});

test("findLastPaintedRow recognizes light report backgrounds", () => {
  const pixels = new Uint8ClampedArray(2 * 4 * 4).fill(255);
  const lightCell = (1 * 2) * 4;
  pixels[lightCell] = 248;
  pixels[lightCell + 1] = 250;
  pixels[lightCell + 2] = 251;

  assert.equal(findLastPaintedRow(pixels, 2, 4), 1);
});

test("findLastPaintedRow returns -1 for an empty or malformed image", () => {
  assert.equal(findLastPaintedRow(new Uint8ClampedArray(4 * 4), 2, 2), -1);
  assert.equal(findLastPaintedRow(new Uint8ClampedArray(3), 2, 2), -1);
});
