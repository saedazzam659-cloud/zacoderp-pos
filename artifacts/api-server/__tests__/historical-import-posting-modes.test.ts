import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("historical posting mode is stored and enforced in all invoice and return posting routes", async () => {
  const [sales, purchasing, salesSchema, purchaseSchema] = await Promise.all([
    readFile(new URL("../src/routes/sales.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/purchasing.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../lib/db/src/schema/sales.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../lib/db/src/schema/purchasing.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [salesSchema, purchaseSchema]) {
    assert.match(source, /historicalImportMode:\s*text\("historical_import_mode"\)/);
  }
  assert.match(sales, /historicalImportMode: requestedHistoricalImportMode/);
  assert.match(purchasing, /historicalImportMode: requestedHistoricalImportMode/);

  const routeRanges = [
    sales.slice(sales.indexOf("async function postSalesInvoiceHandler"), sales.indexOf('router.patch("/sales-invoices/:id/unpost"')),
    sales.slice(sales.indexOf('"/sales-returns/:id/post"'), sales.indexOf('"/sales-returns/:id/unpost"')),
    purchasing.slice(purchasing.indexOf('router.patch("/purchase-invoices/:id/post"'), purchasing.indexOf('router.patch("/purchase-invoices/:id/unpost"')),
    purchasing.slice(purchasing.indexOf('router.patch("/purchase-returns/:id/post"'), purchasing.indexOf('router.patch("/purchase-returns/:id/unpost"')),
  ];
  for (const route of routeRanges) {
    assert.match(route, /historicalImportMode === "archive_only"/);
    assert.match(route, /historicalImportMode !== "financial_only"/);
    assert.match(route, /historicalImportMode (?:===|!==) "inventory_only"/);
  }
  assert.match(sales, /historicalImportMode: salesInvoicesTable\.historicalImportMode/);
  assert.match(purchasing, /historicalImportMode: purchaseInvoicesTable\.historicalImportMode/);
});

test("historical importer preserves staged financial mode and does not post draft-only imports", async () => {
  const ui = await readFile(new URL("../../zatca-invoicing/src/pages/settings/HistoricalDocumentsMigration.tsx", import.meta.url), "utf8");
  assert.match(ui, /financial_inventory.*financial_only.*inventory_only.*archive_only/s);
  assert.match(ui, /historicalImportMode: postingMode/);
  assert.match(ui, /if \(converted\.warnings\.length && sourceKind !== "purchase_order"\)/);
  assert.match(ui, /parseDocuments\(converted\.rows, kind, true, converted\.warnings\.length > 0\)/);
  assert.match(ui, /!allowMissingPayment && !String\(row\.payment_type/);
  assert.match(ui, /doc\.kind === "purchase_order" \? "\/api\/purchasing\/purchase-orders"/);
  assert.match(ui, /مسودة أمر شراء — بلا قيد مالي أو حركة مخزون/);
  assert.match(ui, /postingMode === "archive_only" \|\| saveAsDraftOnly/);
  assert.match(ui, /saveAsDraft: true/);
  assert.match(ui, /paymentType: doc\.paymentType \|\| \(\(postingMode === "archive_only" \|\| saveAsDraftOnly\) \? "credit" : ""\)/);
  assert.match(ui, /postingMode !== "archive_only" && !saveAsDraftOnly && created\.status !== "posted"/);
});

test("historical import review applies batch defaults and lets users jump to and correct invalid line values", async () => {
  const ui = await readFile(new URL("../../zatca-invoicing/src/pages/settings/HistoricalDocumentsMigration.tsx", import.meta.url), "utf8");
  assert.match(ui, /تطبيق الفرع والمخزن ووحدة القياس المحددة على كل المستندات والسطور/);
  assert.match(ui, /applyBatchDefaults && importUnitCode/);
  assert.match(ui, /applyBatchDefaults && importWarehouseCode/);
  assert.match(ui, /onDoubleClick=\{\(\) => focusFirstInvalidLine\(doc\)\}/);
  assert.match(ui, /scrollIntoView\(\{ behavior: "smooth", block: "center", inline: "center" \}\)/);
  assert.match(ui, /تفاصيل الخطأ للمستند \$\{doc\.sourceNumber\}/);
  assert.match(ui, /data-import-line/);
  assert.match(ui, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(ui, /const itemIssue = issue\.includes\("الصنف:"\)/);
  assert.match(ui, /استبدل كود المصدر بكود صنف مسجل في هذه الشركة/);
  assert.match(ui, /editableTextLineFields\.has\(field\)/);
  assert.match(ui, /field === "item_code" \? "كود الصنف" : "اسم الصنف"/);
  assert.match(ui, /editableLineFields\.has\(field\)/);
  assert.match(ui, /عالج أخطاء الإدخال أولًا/);
});
