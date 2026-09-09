import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/routes/sequences.ts", import.meta.url),
  "utf8",
);

test("deactivating a used sequence does not treat its unchanged display seed as a counter decrease", () => {
  assert.match(
    source,
    /Number\(merged\.currentNumber\)\s*!==\s*Number\(existing\.currentNumber\)[\s\S]*Number\(merged\.currentNumber\)\s*<=\s*highWaterMark/,
  );
});