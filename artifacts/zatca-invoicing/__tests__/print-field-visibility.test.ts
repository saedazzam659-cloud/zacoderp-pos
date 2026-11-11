import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrintFieldVisible,
  shouldRenderPrintColumn,
} from "../src/lib/printFieldVisibility.ts";

test("hidden print columns are omitted while accounting data remains available", () => {
  const settings = {
    sales_quotation: {
      freeQuantity: false,
      discountPercent: false,
      discountAmount: false,
    },
    sales_invoice: {
      discountPercent: true,
    },
  };

  assert.equal(
    shouldRenderPrintColumn(settings, "sales_quotation", "freeQuantity", true),
    false,
  );
  assert.equal(
    shouldRenderPrintColumn(settings, "sales_quotation", "discountPercent", true),
    false,
  );
  assert.equal(
    shouldRenderPrintColumn(settings, "sales_quotation", "discountAmount", true),
    false,
  );
  assert.equal(
    shouldRenderPrintColumn(settings, "sales_invoice", "discountPercent", true),
    true,
  );
  assert.equal(
    shouldRenderPrintColumn(settings, "sales_quotation", "discountAmount", false),
    false,
  );

  // Hiding a print column is presentation-only; the stored setting does not
  // mutate the source line values used to calculate invoice totals.
  assert.equal(isPrintFieldVisible(settings, "sales_quotation", "discountAmount"), false);
  assert.equal(settings.sales_quotation.discountAmount, false);
});

test("unset print-column preferences preserve the existing template output", () => {
  assert.equal(shouldRenderPrintColumn(undefined, "sales_quotation", "freeQuantity", true), true);
  assert.equal(shouldRenderPrintColumn(undefined, undefined, "discountAmount", true), true);
  assert.equal(shouldRenderPrintColumn(undefined, "sales_quotation", "freeQuantity", false), false);
});
