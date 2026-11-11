import assert from "node:assert/strict";
import test from "node:test";
import {
  inferPrintFieldFromLabel,
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

test("sales quotation settings independently control both discount columns", () => {
  const settings = {
    sales_quotation: {
      discountPercent: true,
      discountAmount: false,
      date: false,
      createdAt: false,
      printedAt: false,
    },
  };

  assert.equal(
    shouldRenderPrintColumn(settings, "sales_quotation", "discountPercent", true),
    true,
  );
  assert.equal(
    shouldRenderPrintColumn(settings, "sales_quotation", "discountAmount", true),
    false,
  );
  assert.equal(
    shouldRenderPrintColumn(settings, "sales_invoice", "discountAmount", true),
    true,
  );
  assert.equal(isPrintFieldVisible(settings, "sales_quotation", "date"), false);
  assert.equal(isPrintFieldVisible(settings, "sales_quotation", "createdAt"), false);
  assert.equal(isPrintFieldVisible(settings, "sales_quotation", "printedAt"), false);
});

test("Arabic print labels identify fields even when followed by values", () => {
  assert.equal(inferPrintFieldFromLabel("تاريخ الطباعة: 2026/11/11", "sales_quotation"), "printedAt");
  assert.equal(inferPrintFieldFromLabel("تاريخ الإنشاء: 2026/11/11", "sales_quotation"), "createdAt");
  assert.equal(inferPrintFieldFromLabel("تاريخ العرض: 2026/11/11", "sales_quotation"), "date");
  assert.equal(inferPrintFieldFromLabel("ملاحظات: تسليم عاجل", "sales_quotation"), "notes");
});
