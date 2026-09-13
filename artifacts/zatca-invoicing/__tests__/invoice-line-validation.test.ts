import assert from "node:assert/strict";
import test from "node:test";
import { validateInvoiceLines } from "../src/lib/lineValidation.ts";

test("invoice validation ignores untouched filler rows but requires a selected item", () => {
  const result = validateInvoiceLines(
    [{ itemId: "", itemName: "", qty: "1", unitPrice: "0" }],
    { requireRealItem: true },
  );
  assert.equal(result.ok, false);

  const service = validateInvoiceLines(
    [{ itemId: "42", itemName: "استشارة", unitId: "1", qty: "1", unitPrice: "100" }],
    { requireRealItem: true },
  );
  assert.equal(service.ok, true);
});

test("description-only rows fail invoice validation", () => {
  const result = validateInvoiceLines(
    [{ itemId: "", itemName: "وصف فقط", unitId: "", qty: "1", unitPrice: "0" }],
    { requireRealItem: true },
  );
  assert.equal(result.ok, false);
});

test("quotation/order-compatible validation remains opt-in for real item IDs", () => {
  const result = validateInvoiceLines(
    [{ itemId: "", itemName: "خدمة موصوفة", unitId: "1", qty: "1", unitPrice: "100" }],
  );
  assert.equal(result.ok, false);
  assert.equal(validateInvoiceLines(
    [{ itemId: "42", itemName: "خدمة", unitId: "1", qty: "1", unitPrice: "100" }],
  ).ok, true);
});
