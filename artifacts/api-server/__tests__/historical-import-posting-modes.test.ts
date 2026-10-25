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

test("historical importer carries the chosen mode and keeps archive-only documents unnumbered drafts", async () => {
  const ui = await readFile(new URL("../../zatca-invoicing/src/pages/settings/HistoricalDocumentsMigration.tsx", import.meta.url), "utf8");
  assert.match(ui, /financial_inventory.*financial_only.*inventory_only.*archive_only/s);
  assert.match(ui, /historicalImportMode: postingMode/);
  assert.match(ui, /postingMode === "archive_only" \? \{ saveAsDraft: true \}/);
  assert.match(ui, /postingMode !== "archive_only".*requestJson\(postPath/);
});
