import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const companiesSchema = readFileSync(
  new URL("../../../lib/db/src/schema/companies.ts", import.meta.url),
  "utf8",
);
const schemaHeal = readFileSync(
  new URL("../../api-server/src/lib/ensureSchema.ts", import.meta.url),
  "utf8",
);
const generalSettings = readFileSync(
  new URL("../src/pages/GeneralSettings.tsx", import.meta.url),
  "utf8",
);
const purchaseForm = readFileSync(
  new URL("../src/pages/purchasing/PurchaseInvoiceForm.tsx", import.meta.url),
  "utf8",
);

test("new companies default batch and expiry capture off while existing companies keep current behavior", () => {
  assert.match(companiesSchema, /purchaseBatchExpiryEnabled: boolean\("purchase_batch_expiry_enabled"\)\.notNull\(\)\.default\(false\)/);
  assert.match(schemaHeal, /purchase_batch_expiry_existing_companies_v1/);
  assert.match(schemaHeal, /UPDATE companies SET purchase_batch_expiry_enabled = TRUE/);
  assert.match(schemaHeal, /ALTER COLUMN purchase_batch_expiry_enabled SET DEFAULT FALSE/);
});

test("general settings controls visibility of purchase invoice batch and expiry inputs", () => {
  assert.match(generalSettings, /purchaseBatchExpiryEnabled: event\.target\.checked/);
  assert.match(purchaseForm, /const showBatchExpiryFields = user\?\.company\?\.purchaseBatchExpiryEnabled === true/);
  assert.match(purchaseForm, /\.\.\.\(showBatchExpiryFields \? \["رقم التشغيلة", "تاريخ الانتهاء"\] : \[\]\)/);
  assert.match(purchaseForm, /showBatchExpiryFields && \(isNoStockLine\(l\)/);
});
