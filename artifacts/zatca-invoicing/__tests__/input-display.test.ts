import assert from "node:assert/strict";
import test from "node:test";

import {
  isOneValue,
  isZeroValue,
  shouldBlankNumericValue,
} from "../src/lib/inputDisplay";

test("recognizes only real numeric zero and one values", () => {
  assert.equal(isZeroValue(0), true);
  assert.equal(isZeroValue("0.000"), true);
  assert.equal(isZeroValue(""), false);
  assert.equal(isZeroValue("not-a-number"), false);
  assert.equal(isOneValue(1), true);
  assert.equal(isOneValue("1.000"), true);
  assert.equal(isOneValue("10"), false);
});

test("zero follows the company display preference", () => {
  assert.equal(shouldBlankNumericValue({
    value: 0,
    showZeros: false,
    hideDefaultOne: false,
    focused: false,
    typedSinceFocus: false,
  }), true);
  assert.equal(shouldBlankNumericValue({
    value: 0,
    showZeros: true,
    hideDefaultOne: false,
    focused: false,
    typedSinceFocus: false,
  }), false);
});

test("quantity one is blank only for opted-in fields and typing wins", () => {
  assert.equal(shouldBlankNumericValue({
    value: 1,
    showZeros: true,
    hideDefaultOne: true,
    focused: false,
    typedSinceFocus: false,
  }), true);
  assert.equal(shouldBlankNumericValue({
    value: 1,
    showZeros: true,
    hideDefaultOne: false,
    focused: false,
    typedSinceFocus: false,
  }), false);
  assert.equal(shouldBlankNumericValue({
    value: 1,
    showZeros: true,
    hideDefaultOne: true,
    focused: true,
    typedSinceFocus: true,
  }), false);
});