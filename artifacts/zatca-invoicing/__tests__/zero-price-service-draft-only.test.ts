import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("zero-priced service invoices save as drafts instead of auto-posting", async () => {
  const source = await readFile(new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url), "utf8");

  assert.match(source, /const zeroPriceServiceDraftOnly = isInvoice && lines\.some/);
  assert.match(source, /if \(deferDraftZeroPriceService\) return \{ \.\.\.j, __zeroPriceServiceDraft: true \};/);
  assert.match(source, /if \(saved\?\.__zeroPriceServiceDraft\)/);
  assert.match(source, /!zeroPriceServiceDraftOnly/);
  assert.match(source, /t\("salesDocForm\.saveDraftAction"\)/);
});

test("the company zero-price service setting also enables quotation line validation", async () => {
  const source = await readFile(new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url), "utf8");

  assert.match(source, /\(isInvoice \|\| isQuotation\) && user\?\.company\?\.allowZeroPriceServiceItems === true/);
});

test("General Settings explains the draft-only invoice rule", async () => {
  const source = await readFile(new URL("../src/pages/GeneralSettings.tsx", import.meta.url), "utf8");

  assert.match(source, /يمكن حفظ عروض الأسعار وفواتير المبيعات ومرتجعاتها بسعر صفر/);
  assert.match(source, /تُحفظ كمسودة ولا تُرحّل/);
});
