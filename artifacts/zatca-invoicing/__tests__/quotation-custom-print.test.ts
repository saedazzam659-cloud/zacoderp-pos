import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getDefaultSalesPrintTemplateId,
  getDefaultQuotationBaseTemplateId,
  getEnabledSalesPrintTemplates,
} from "../src/lib/salesPrintTemplateCatalog";
import { renderQuotationCustomLayoutHtml } from "../src/lib/quotationCustomPrint";
import { createQuotationBaseLayout } from "../src/pages/printDesigner/presets";
import type { Layout } from "../src/pages/printDesigner/types";

test("quotation base templates respect enabled IDs and quotation default precedence", () => {
  const company = {
    printEnabledTemplates: [6, 7, 999],
    printDefaultTemplateQuotation: 6,
    printDefaultTemplate: 7,
  };
  const enabled = getEnabledSalesPrintTemplates(company);
  assert.deepEqual(enabled.map(template => template.id), [6, 7]);
  assert.equal(getDefaultQuotationBaseTemplateId(company, enabled), 6);
  assert.equal(
    getDefaultQuotationBaseTemplateId(
      { ...company, printDefaultTemplateQuotation: 14 },
      enabled,
    ),
    7,
  );
});

test("sales base template defaults follow each document setting and enabled template list", () => {
  const company = {
    printEnabledTemplates: [6, 7],
    printDefaultTemplate: 7,
    printDefaultTemplateReturn: 6,
    printDefaultTemplateQuotation: 6,
  };
  const enabled = getEnabledSalesPrintTemplates(company);
  assert.equal(getDefaultSalesPrintTemplateId(company, enabled, "sales_invoice"), 7);
  assert.equal(getDefaultSalesPrintTemplateId(company, enabled, "sales_quotation"), 6);
  assert.equal(getDefaultSalesPrintTemplateId(company, enabled, "sales_return"), 6);
  assert.equal(
    getDefaultSalesPrintTemplateId(
      { ...company, printDefaultTemplate: 14 },
      enabled,
      "sales_invoice",
    ),
    6,
  );
});

test("sales base layouts retain the native system template as a protected source", () => {
  const original = createQuotationBaseLayout(2, "#059669");
  const copy = createQuotationBaseLayout(6, "#111111", true);

  assert.equal(original.baseTemplateId, 2);
  assert.equal(original.baseTemplateVersion, 2);
  assert.deepEqual(original.elements, []);
  assert.equal(copy.baseTemplateId, 6);
  assert.equal(copy.baseTemplateVersion, 2);
  assert.deepEqual(copy.elements, []);
});

test("custom quotation layout renders real field and line values safely", () => {
  const layout: Layout = {
    elements: [
      {
        id: "number",
        type: "field",
        x: 12,
        y: 15,
        width: 180,
        height: 24,
        fieldKey: "quotation.number",
        text: "رقم العرض: {رقم عرض السعر}",
        fontSize: 12,
      },
      {
        id: "items",
        type: "table",
        x: 12,
        y: 48,
        width: 180,
        height: 100,
        tableSpec: {
          columns: [
            { key: "name", label: "الصنف", width: 100 },
            { key: "total", label: "الإجمالي", width: 80, align: "end" },
          ],
        },
      },
    ],
  };
  const html = renderQuotationCustomLayoutHtml(
    layout,
    {
      fields: { "quotation.number": "SQ-2026-0042<script>alert(1)</script>" },
      rows: [{ name: "خدمة دعم", total: "690.00 ر.س" }],
    },
    { widthMm: 210, heightMm: 297, name: "عرض سعر تجريبي" },
  );

  assert.match(html, /SQ-2026-0042&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /خدمة دعم/);
  assert.match(html, /690\.00 ر\.س/);
  assert.match(html, /@page\{size:210mm 297mm;margin:0\}/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("designer copies enabled bases and the sales print chooser keeps custom templates additive", () => {
  const designerSource = readFileSync(
    new URL("../src/pages/PrintDesigner.tsx", import.meta.url),
    "utf8",
  );
  const salesPrintSource = readFileSync(
    new URL("../src/pages/sales/SalesPrintModal.tsx", import.meta.url),
    "utf8",
  );
  const settingsSource = readFileSync(
    new URL("../src/pages/GeneralSettings.tsx", import.meta.url),
    "utf8",
  );

  assert.match(designerSource, /getDefaultSalesPrintTemplateId/);
  assert.match(designerSource, /startFromSalesBase/);
  assert.match(designerSource, /button-restore-original-design/);
  assert.match(designerSource, /select-sales-base-template/);
  assert.match(salesPrintSource, /customSalesTemplatesQuery/);
  assert.match(salesPrintSource, /renderSalesBaseTemplatePreviewHtml/);
  assert.match(salesPrintSource, /renderQuotationCustomLayoutHtml/);
  assert.match(salesPrintSource, /orderedVisibleTemplates\.map/);
  assert.match(settingsSource, /SALES_PRINT_TEMPLATE_CATALOG/);
});
