import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/lib/posOperationsApi.ts", import.meta.url),
  "utf8",
);

test("POS operation mutations use the mounted sales API routes", () => {
  assert.match(source, /postInvoice:.*`\/api\/sales\/sales-invoices\/\$\{id\}\/post`/);
  assert.match(source, /unpostInvoice:.*`\/api\/sales\/sales-invoices\/\$\{id\}\/unpost`/);
  assert.match(source, /postReturn:.*`\/api\/sales\/sales-returns\/\$\{id\}\/post`/);
  assert.doesNotMatch(source, /`\/api\/sales-invoices\/\$\{id\}\/post`/);
});
