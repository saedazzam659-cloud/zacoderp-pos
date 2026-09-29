import assert from "node:assert/strict";
import test from "node:test";

import {
  isZeroValue,
  shouldBlankNumericValue,
} from "../src/lib/inputDisplay";

test("recognizes only real numeric zero values", () => {
  assert.equal(isZeroValue(0), true);
  assert.equal(isZeroValue("0.000"), true);
  assert.equal(isZeroValue(""), false);
  assert.equal(isZeroValue("not-a-number"), false);
});

test("zero follows the company display preference", () => {
  assert.equal(shouldBlankNumericValue({
    value: 0,
    showZeros: false,
    focused: false,
    typedSinceFocus: false,
  }), true);
  assert.equal(shouldBlankNumericValue({
    value: 0,
    showZeros: true,
    focused: false,
    typedSinceFocus: false,
  }), false);
});

test("quantity one stays visible regardless of zero preference or focus", () => {
  assert.equal(shouldBlankNumericValue({
    value: 1,
    showZeros: false,
    focused: false,
    typedSinceFocus: false,
  }), false);
  assert.equal(shouldBlankNumericValue({
    value: "1.000",
    showZeros: true,
    focused: false,
    typedSinceFocus: false,
  }), false);
  assert.equal(shouldBlankNumericValue({
    value: 1,
    showZeros: false,
    focused: true,
    typedSinceFocus: true,
  }), false);
});

test("typing a zero while focused remains visible", () => {
  assert.equal(shouldBlankNumericValue({
    value: 0,
    showZeros: false,
    focused: true,
    typedSinceFocus: true,
  }), false);
});