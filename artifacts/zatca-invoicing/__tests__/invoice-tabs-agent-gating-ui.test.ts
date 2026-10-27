import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getInvoiceTabColorClass,
  INVOICE_TAB_COLOR_CLASSES,
} from "../src/lib/invoiceTabColors";

const salesForm = readFileSync(
  new URL("../src/pages/sales/SalesDocumentForm.tsx", import.meta.url),
  "utf8",
);
const purchaseForm = readFileSync(
  new URL("../src/pages/purchasing/PurchaseInvoiceForm.tsx", import.meta.url),
  "utf8",
);
const agentSettings = readFileSync(
  new URL("../src/pages/admin/AgentServers.tsx", import.meta.url),
  "utf8",
);

test("colorful navigation is opt-in for both sales and purchase invoices", () => {
  assert.match(salesForm, /const colorInvoiceTabs = isInvoice && colorfulInvoiceTabs;/);
  assert.match(salesForm, /useAgentColorfulInvoiceTabs/);
  assert.match(salesForm, /getInvoiceTabColorClass\("payments", colorInvoiceTabs\)/);
  assert.match(purchaseForm, /useAgentColorfulInvoiceTabs/);
  assert.match(purchaseForm, /getInvoiceTabColorClass\("payments", colorfulInvoiceTabs\)/);
  assert.ok(agentSettings.includes('data-testid="checkbox-agent-colorful-invoice-tabs"'));
  assert.ok(agentSettings.includes("colorfulInvoiceTabs: event.target.checked"));
});

test("tab accents are absent when disabled and distinguish the available tabs when enabled", () => {
  assert.equal(getInvoiceTabColorClass("basic", false), "");

  const accents = Object.values(INVOICE_TAB_COLOR_CLASSES);
  assert.ok(accents.length >= 10);
  assert.ok(accents.every(classes => classes.includes("data-[state=active]:bg-")));
  assert.equal(new Set(accents).size, accents.length);
});

test("new sales invoices require a customer before items and focus barcode entry when enabled", () => {
  assert.match(salesForm, /if \(!customerId\) \{\s*missing\.push\(isRtl \? "العميل" : "Customer"\);\s*\}/);
  assert.match(
    salesForm,
    /activeTab !== "items"[\s\S]*barcodeEntryInputRef\.current\?\.focus\(\)/,
  );
  assert.match(salesForm, /data-testid="sales-barcode-entry"/);
  assert.match(salesForm, /async function scanSalesItemByCode\(rawCode: string\)/);
  assert.match(
    salesForm,
    /updateLine\(existingLine\._id, "qty", String\(\(Number\(existingLine\.qty\) \|\| 0\) \+ 1\)\)/,
  );
});