import assert from "node:assert/strict";
import test from "node:test";

import { sourceDocumentUrl } from "../src/lib/sourceDocumentLinks.ts";

test("resolves invoice source links to their document forms", () => {
  assert.equal(sourceDocumentUrl("sales_invoice", 17), "/sales/invoices/17");
  assert.equal(sourceDocumentUrl("purchase_invoice", "23"), "/purchasing/invoices/23");
});

test("resolves return source links to read-only purchase and sales forms", () => {
  assert.equal(sourceDocumentUrl("sales_return", 41), "/sales/returns?edit=41&view=1");
  assert.equal(sourceDocumentUrl("purchase_return", "52"), "/purchasing/returns?edit=52&view=1");
});

test("return links without a usable source ID safely open their lists", () => {
  assert.equal(sourceDocumentUrl("sales_return", null), "/sales/returns");
  assert.equal(sourceDocumentUrl("purchase_return", "not-a-number"), "/purchasing/returns");
});