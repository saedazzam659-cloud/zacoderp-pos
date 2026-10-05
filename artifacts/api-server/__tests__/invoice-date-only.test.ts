import assert from "node:assert/strict";
import test from "node:test";
import { parseInvoiceDateFields } from "../src/lib/invoiceDateOnly.js";

test("invoice date fields preserve validated calendar dates", () => {
  assert.deepEqual(parseInvoiceDateFields({
    issueDate: "2024-02-29",
    supplyDate: "2024-03-01",
  }), {
    issueDate: "2024-02-29",
    supplyDate: "2024-03-01",
    dueDate: null,
  });
});

test("invoice date fields reject invalid calendar dates and timestamps", () => {
  assert.equal(parseInvoiceDateFields({ issueDate: "2023-02-29" }), null);
  assert.equal(parseInvoiceDateFields({ issueDate: "2024-02-29T00:00:00.000Z" }), null);
  assert.equal(parseInvoiceDateFields({ issueDate: "2024-2-09" }), null);
});

test("optional invoice dates must also be date-only when supplied", () => {
  assert.equal(parseInvoiceDateFields({
    issueDate: "2024-02-29",
    dueDate: "2024-04-01T00:00:00Z",
  }), null);
});
