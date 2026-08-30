import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  firstJournalDescription,
  itemNamesDescription,
  itemNamesWithSupplierDescription,
  namedPartyDescription,
  purchaseSupplierDescription,
} from "../src/lib/journalLineDescriptions.js";

const here = fileURLToPath(new URL(".", import.meta.url));

test("journal descriptions prefer the entered general description", () => {
  assert.equal(
    firstJournalDescription("  تحصيل دفعة من العميل  ", "شرح السطر", "سند قبض RV-1"),
    "تحصيل دفعة من العميل",
  );
});

test("item descriptions deduplicate item names and include the supplier", () => {
  assert.equal(
    itemNamesWithSupplierDescription(
      ["تكلفة صنف خدمي", "تكلفة صنف خدمي", "مستلزمات المشروع"],
      "شركة المورد",
      "قيد مشتريات",
    ),
    "الصنف: تكلفة صنف خدمي، مستلزمات المشروع — المورد: شركة المورد",
  );
});

test("sales and party descriptions have safe fallbacks", () => {
  assert.equal(itemNamesDescription(["صنف أ", "صنف ب"], "إيراد المبيعات"), "الصنف: صنف أ، صنف ب");
  assert.equal(namedPartyDescription("المورد", "شركة ألف", "سند صرف"), "المورد: شركة ألف");
  assert.equal(namedPartyDescription("المورد", " ", "سند صرف"), "سند صرف");
});

test("purchase supplier description includes both invoice numbers and supplier date", () => {
  assert.equal(
    purchaseSupplierDescription({
      supplierName: "شركة المورد",
      purchaseInvoiceNumber: "PUR-2026-0031",
      supplierInvoiceNumber: "SUP-778",
      supplierInvoiceDate: "2026-08-30",
      fallback: "قيد مشتريات",
    }),
    "المورد: شركة المورد — فاتورة المشتريات: PUR-2026-0031 — فاتورة المورد: SUP-778 — تاريخ فاتورة المورد: 30/08/2026",
  );
});

test("all requested posting paths use document-driven line descriptions", () => {
  const payment = readFileSync(resolve(here, "../src/routes/payment-vouchers.ts"), "utf8");
  const receipt = readFileSync(resolve(here, "../src/routes/receipt-vouchers.ts"), "utf8");
  const purchase = readFileSync(resolve(here, "../src/routes/purchasing.ts"), "utf8");
  const purchaseReports = readFileSync(resolve(here, "../src/routes/purchases-analytics.ts"), "utf8");
  const sales = readFileSync(resolve(here, "../src/routes/sales.ts"), "utf8");
  const reports = readFileSync(resolve(here, "../src/routes/reports-accounting.ts"), "utf8");
  const hr = readFileSync(resolve(here, "../src/lib/hr-journals.ts"), "utf8");

  assert.match(payment, /description: supplierDesc/);
  assert.match(receipt, /firstJournalDescription\(v\.description, l\.description, desc\)/);
  assert.match(purchase, /itemNamesWithSupplierDescription\(serviceItemNamesByAccount\[key\]/);
  assert.match(purchase, /purchaseSupplierDescription/);
  assert.match(purchase, /description: supplierLineDesc/);
  assert.match(purchaseReports, /supplierInvoiceDate: purchaseInvoicesTable\.supplierInvoiceDate/);
  assert.match(purchaseReports, /purchaseSupplierDescription/);
  assert.match(sales, /description: soldItemsDescription/);
  assert.match(sales, /credit: vatAmt,[\s\S]{0,120}description: journalDescription/);
  assert.match(reports, /historicalSalesVatHeaderDesc/);
  assert.match(reports, /voucherDesc \?\? historicalSalesVatHeaderDesc/);
  assert.match(reports, /فاتورة المشتريات/);
  assert.match(reports, /فاتورة المبيعات/);
  assert.match(reports, /تاريخ فاتورة المورد:/);
  assert.match(hr, /accountId: cash\.accountId,[\s\S]{0,140}description: desc/);
});