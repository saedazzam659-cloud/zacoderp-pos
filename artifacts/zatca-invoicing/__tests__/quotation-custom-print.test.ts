import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
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

test("quotation base layouts are independent editable copies with the selected style", () => {
  const original = createQuotationBaseLayout(2, "#059669");
  const copy = createQuotationBaseLayout(6, "#111111", true);

  assert.equal(original.baseTemplateId, 2);
  assert.ok(original.elements.some(element => element.fieldKey === "quotation.validUntil"));
  assert.ok(original.elements.some(element => element.type === "table"));
  assert.notEqual(original.elements[0], copy.elements[0]);
  assert.equal(copy.baseTemplateId, 6);
  assert.ok(copy.elements.some(element => element.fieldKey === "quotation.number"));
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

  assert.match(designerSource, /getDefaultQuotationBaseTemplateId/);
  assert.match(designerSource, /startFromQuotationBase/);
  assert.match(designerSource, /القالب الأصلي في الإعدادات العامة لم يتغير/);
  assert.match(salesPrintSource, /customQuotationTemplatesQuery/);
  assert.match(salesPrintSource, /renderQuotationCustomLayoutHtml/);
  assert.match(salesPrintSource, /orderedVisibleTemplates\.map/);
  assert.match(settingsSource, /SALES_PRINT_TEMPLATE_CATALOG/);
});
